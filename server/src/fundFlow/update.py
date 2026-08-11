from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Iterable

import pandas as pd
import pymysql
import requests
from pymysql.cursors import DictCursor


SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PROGRESS = SERVER_ROOT / ".logs" / "fund-flow" / "progress.json"
PROCESS_STARTED_AT = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
UPSERT_FIELDS = (
    "instrument_key", "trade_date", "close_price", "change_pct",
    "main_net_in", "main_net_ratio",
    "super_large_net_in", "super_large_net_ratio",
    "large_net_in", "large_net_ratio",
    "medium_net_in", "medium_net_ratio",
    "small_net_in", "small_net_ratio", "provider_net_in",
    "source_key", "source_version", "fetched_at", "is_final",
)


@dataclass(frozen=True)
class Instrument:
    instrument_key: int
    symbol: str
    market: str


def load_env(path: Path = SERVER_ROOT / ".env") -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def required_number(value: Any, field: str) -> float:
    number = finite(value)
    if number is None:
        raise ValueError(f"missing numeric field: {field}")
    return number


def tinyshare_record(row: dict[str, Any], instrument_key: int, fetched_at: datetime) -> dict[str, Any]:
    unit = 10_000.0  # Tinyshare/Tushare moneyflow amounts are expressed in 万元.
    small = (required_number(row.get("buy_sm_amount"), "buy_sm_amount")
             - required_number(row.get("sell_sm_amount"), "sell_sm_amount")) * unit
    medium = (required_number(row.get("buy_md_amount"), "buy_md_amount")
              - required_number(row.get("sell_md_amount"), "sell_md_amount")) * unit
    large = (required_number(row.get("buy_lg_amount"), "buy_lg_amount")
             - required_number(row.get("sell_lg_amount"), "sell_lg_amount")) * unit
    super_large = (required_number(row.get("buy_elg_amount"), "buy_elg_amount")
                   - required_number(row.get("sell_elg_amount"), "sell_elg_amount")) * unit
    provider_net = finite(row.get("net_mf_amount"))
    return {
        "instrument_key": instrument_key,
        "trade_date": normalize_date(row.get("trade_date")),
        "close_price": None,
        "change_pct": None,
        "main_net_in": large + super_large,
        "main_net_ratio": None,
        "super_large_net_in": super_large,
        "super_large_net_ratio": None,
        "large_net_in": large,
        "large_net_ratio": None,
        "medium_net_in": medium,
        "medium_net_ratio": None,
        "small_net_in": small,
        "small_net_ratio": None,
        "provider_net_in": None if provider_net is None else provider_net * unit,
        "source_key": "tinyshare_moneyflow",
        "source_version": "moneyflow-v1-main=lg+elg",
        "fetched_at": fetched_at,
        "is_final": 1,
    }


def akshare_record(row: list[Any], instrument_key: int, trade_date: str,
                   fetched_at: datetime) -> dict[str, Any]:
    if len(row) < 15:
        raise ValueError(f"AKShare row has {len(row)} columns; expected at least 15")
    values = [finite(value) for value in row]
    required_positions = (5, 7, 9, 11, 13)
    if any(values[index] is None for index in required_positions):
        raise ValueError("AKShare row is missing one or more fund-flow amounts")
    return {
        "instrument_key": instrument_key,
        "trade_date": trade_date,
        "close_price": values[3],
        "change_pct": values[4],
        "main_net_in": values[5],
        "main_net_ratio": values[6],
        "super_large_net_in": values[7],
        "super_large_net_ratio": values[8],
        "large_net_in": values[9],
        "large_net_ratio": values[10],
        "medium_net_in": values[11],
        "medium_net_ratio": values[12],
        "small_net_in": values[13],
        "small_net_ratio": values[14],
        "provider_net_in": None,
        "source_key": "akshare_eastmoney",
        "source_version": "stock_individual_fund_flow_rank-today",
        "fetched_at": fetched_at,
        "is_final": 1,
    }


def normalize_date(value: Any) -> str:
    text = str(value).strip().replace("-", "")
    if len(text) != 8 or not text.isdigit():
        raise ValueError(f"invalid trade date: {value!r}")
    return f"{text[:4]}-{text[4:6]}-{text[6:]}"


def connect_db() -> pymysql.Connection:
    return pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"),
        charset="utf8mb4",
        autocommit=False,
        cursorclass=DictCursor,
    )


def load_instruments(connection: pymysql.Connection) -> tuple[dict[str, Instrument], dict[str, Instrument]]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT instrument_key, symbol, market FROM instruments WHERE type='stock'")
        rows = cursor.fetchall()
    by_provider: dict[str, Instrument] = {}
    by_symbol_market: dict[str, Instrument] = {}
    for row in rows:
        item = Instrument(int(row["instrument_key"]), str(row["symbol"]).zfill(6), str(row["market"]).upper())
        by_provider[f"{item.symbol}.{item.market}"] = item
        by_symbol_market[f"{item.market}:{item.symbol}"] = item
    return by_provider, by_symbol_market


def load_backfill_dates(connection: pymysql.Connection, start_date: str, end_date: str) -> list[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT trade_date FROM daily_bars_v2 "
            "WHERE trade_date BETWEEN %s AND %s ORDER BY trade_date",
            (start_date, end_date),
        )
        return [row["trade_date"].isoformat() if isinstance(row["trade_date"], date)
                else str(row["trade_date"])[:10] for row in cursor.fetchall()]


def existing_coverage(connection: pymysql.Connection, trade_date: str) -> tuple[int, int]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(DISTINCT instrument_key) AS n FROM daily_bars_v2 WHERE trade_date=%s",
            (trade_date,),
        )
        expected = int(cursor.fetchone()["n"])
        cursor.execute("SELECT COUNT(*) AS n FROM stock_fund_flows WHERE trade_date=%s", (trade_date,))
        actual = int(cursor.fetchone()["n"])
    return actual, expected


def sync_date_completed(connection: pymysql.Connection, source_key: str, trade_date: str) -> bool:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT status FROM fund_flow_sync_dates WHERE source_key=%s AND trade_date=%s",
            (source_key, trade_date),
        )
        row = cursor.fetchone()
    return bool(row and row["status"] == "completed")


def completed_stored_rows(connection: pymysql.Connection, source_key: str,
                          start_date: str, end_date: str) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT COALESCE(SUM(stored_rows), 0) AS n FROM fund_flow_sync_dates "
            "WHERE source_key=%s AND status='completed' AND trade_date BETWEEN %s AND %s",
            (source_key, start_date, end_date),
        )
        return int(cursor.fetchone()["n"])


def record_sync_date(connection: pymysql.Connection, source_key: str, trade_date: str,
                     status: str, provider_rows: int, stored_rows: int,
                     expected_market_rows: int, error_message: str | None = None) -> None:
    coverage = stored_rows / expected_market_rows * 100 if expected_market_rows else None
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO fund_flow_sync_dates
              (source_key, trade_date, status, provider_rows, stored_rows,
               expected_market_rows, coverage_pct, error_message, updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
              status=VALUES(status), provider_rows=VALUES(provider_rows),
              stored_rows=VALUES(stored_rows), expected_market_rows=VALUES(expected_market_rows),
              coverage_pct=VALUES(coverage_pct), error_message=VALUES(error_message),
              updated_at=VALUES(updated_at)
            """,
            (source_key, trade_date, status, provider_rows, stored_rows,
             expected_market_rows, coverage, error_message,
             datetime.now(UTC).replace(tzinfo=None)),
        )
    connection.commit()


def upsert_records(connection: pymysql.Connection, records: Iterable[dict[str, Any]], batch_size: int = 1000) -> int:
    records = list(records)
    if not records:
        return 0
    placeholders = ",".join(["%s"] * len(UPSERT_FIELDS))
    updates = ",".join(f"{field}=VALUES({field})" for field in UPSERT_FIELDS[2:])
    sql = (
        f"INSERT INTO stock_fund_flows ({','.join(UPSERT_FIELDS)}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {updates}"
    )
    with connection.cursor() as cursor:
        for offset in range(0, len(records), batch_size):
            batch = records[offset:offset + batch_size]
            cursor.executemany(sql, [[record.get(field) for field in UPSERT_FIELDS] for record in batch])
    connection.commit()
    return len(records)


def write_progress(path: Path, **payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload["updatedAt"] = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    payload.setdefault("startedAt", PROCESS_STARTED_AT)
    serialized = json.dumps(payload, ensure_ascii=False)
    # A scheduled daily task can briefly overlap the backfill, so each writer needs
    # its own temporary file. On Windows, a reader may also transiently prevent an
    # atomic replace; progress reporting must never terminate the data ingestion.
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(serialized, encoding="utf-8")
        for attempt in range(8):
            try:
                temporary.replace(path)
                return
            except PermissionError:
                if attempt < 7:
                    time.sleep(0.05 * (attempt + 1))
        try:
            path.write_text(serialized, encoding="utf-8")
        except OSError as exc:
            print(json.dumps({"warning": "progress write skipped", "error": str(exc)},
                             ensure_ascii=False), file=sys.stderr, flush=True)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def call_with_retries(callable_obj: Any, attempts: int, delay: float) -> pd.DataFrame:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            result = callable_obj()
            if not isinstance(result, pd.DataFrame):
                raise TypeError("provider did not return a DataFrame")
            return result
        except Exception as exc:  # provider errors vary across requests/urllib stacks
            last_error = exc
            if attempt < attempts:
                time.sleep(delay * (2 ** (attempt - 1)))
    raise RuntimeError(f"provider failed after {attempts} attempts: {last_error}")


def run_tinyshare_backfill(args: argparse.Namespace) -> int:
    import tinyshare as ts

    token = os.getenv("TINYSHARE_TOKEN", "").strip()
    if not token:
        raise RuntimeError("TINYSHARE_TOKEN is not configured")
    ts.set_token(token)
    provider = ts.pro_api()
    connection = connect_db()
    progress = Path(args.progress_file)
    try:
        by_provider, _ = load_instruments(connection)
        dates = load_backfill_dates(connection, args.start_date, args.end_date)
        completed = 0
        failed = 0
        inserted = completed_stored_rows(connection, "tinyshare_moneyflow",
                                         args.start_date, args.end_date)
        write_progress(progress, status="running", phase="tinyshare-backfill", completed=0,
                       total=len(dates), failed=0, inserted=0, currentDate=None)
        for trade_date in dates:
            if sync_date_completed(connection, "tinyshare_moneyflow", trade_date):
                completed += 1
                continue
            _, expected = existing_coverage(connection, trade_date)
            compact_date = trade_date.replace("-", "")
            try:
                frame = call_with_retries(
                    lambda: provider.moneyflow(trade_date=compact_date), args.attempts, args.retry_delay,
                )
                fetched_at = datetime.now(UTC).replace(tzinfo=None)
                records = []
                unmatched = 0
                invalid = 0
                for row in frame.to_dict("records"):
                    instrument = by_provider.get(str(row.get("ts_code", "")).upper())
                    if not instrument:
                        unmatched += 1
                        continue
                    try:
                        records.append(tinyshare_record(row, instrument.instrument_key, fetched_at))
                    except ValueError:
                        invalid += 1
                coverage = len(records) / expected if expected else 0
                source_mapping_coverage = len(records) / len(frame) if len(frame) else 0
                if not len(frame) or source_mapping_coverage < args.min_source_coverage:
                    raise RuntimeError(
                        f"source mapping coverage {source_mapping_coverage:.2%} below "
                        f"{args.min_source_coverage:.2%} (provider={len(frame)}, records={len(records)}, "
                        f"unmatched={unmatched}, invalid={invalid})"
                    )
                inserted += upsert_records(connection, records)
                record_sync_date(connection, "tinyshare_moneyflow", trade_date, "completed",
                                 len(frame), len(records), expected)
                completed += 1
                print(json.dumps({"date": trade_date, "rows": len(records), "expected": expected,
                                  "marketCoverage": round(coverage, 4),
                                  "sourceMappingCoverage": round(source_mapping_coverage, 4),
                                  "unmatched": unmatched}, ensure_ascii=False), flush=True)
            except Exception as exc:
                connection.rollback()
                record_sync_date(connection, "tinyshare_moneyflow", trade_date, "failed",
                                 0, 0, expected, str(exc)[:1000])
                failed += 1
                print(json.dumps({"date": trade_date, "error": str(exc)}, ensure_ascii=False),
                      file=sys.stderr, flush=True)
                if not args.continue_on_error:
                    write_progress(progress, status="failed", phase="tinyshare-backfill",
                                   completed=completed, total=len(dates), failed=failed,
                                   inserted=inserted, currentDate=trade_date, message=str(exc))
                    return 1
            write_progress(progress, status="running", phase="tinyshare-backfill",
                           completed=completed, total=len(dates), failed=failed,
                           inserted=inserted, currentDate=trade_date)
            if args.request_interval > 0:
                time.sleep(args.request_interval)
        status = "completed" if failed == 0 else "completed_with_errors"
        write_progress(progress, status=status, phase="tinyshare-backfill", completed=completed,
                       total=len(dates), failed=failed, inserted=inserted, currentDate=dates[-1] if dates else None)
        return 0 if failed == 0 else 2
    finally:
        connection.close()


def infer_market(symbol: str) -> str:
    if symbol.startswith(("4", "8")):
        return "BJ"
    if symbol.startswith(("6", "9")):
        return "SH"
    return "SZ"


def fetch_eastmoney_rank_fallback() -> pd.DataFrame:
    endpoints = (
        "https://push2delay.eastmoney.com/api/qt/clist/get",
        "https://push2.eastmoney.com/api/qt/clist/get",
        "https://82.push2.eastmoney.com/api/qt/clist/get",
        "https://7.push2.eastmoney.com/api/qt/clist/get",
        "https://48.push2.eastmoney.com/api/qt/clist/get",
    )
    base_params = {
        "fid": "f62", "po": "1", "pz": "100", "np": "1", "fltt": "2", "invt": "2",
        "fs": "m:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:7+f:!2,m:1+t:3+f:!2",
        "fields": "f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87",
    }
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        "Referer": "https://data.eastmoney.com/",
    })

    def page(number: int) -> tuple[int, list[dict[str, Any]]]:
        last_error: Exception | None = None
        for endpoint in endpoints:
            try:
                response = session.get(endpoint, params={**base_params, "pn": str(number)}, timeout=15)
                response.raise_for_status()
                payload = response.json().get("data") or {}
                rows = payload.get("diff") or []
                total = int(payload.get("total") or 0)
                if total <= 0 or not rows:
                    raise RuntimeError("empty Eastmoney rank page")
                return total, rows
            except Exception as exc:
                last_error = exc
        raise RuntimeError(f"all Eastmoney rank endpoints failed for page {number}: {last_error}")

    total, first_rows = page(1)
    rows = list(first_rows)
    for page_number in range(2, math.ceil(total / 100) + 1):
        _, page_rows = page(page_number)
        rows.extend(page_rows)
        time.sleep(0.05)
    columns = ("f12", "f14", "f2", "f3", "f62", "f184", "f66", "f69",
               "f72", "f75", "f78", "f81", "f84", "f87")
    return pd.DataFrame([
        [rank, *(row.get(column) for column in columns)]
        for rank, row in enumerate(rows, start=1)
    ])


def fetch_akshare_daily_frame() -> pd.DataFrame:
    import akshare as ak
    try:
        return ak.stock_individual_fund_flow_rank(indicator="今日")
    except Exception as primary_error:
        print(json.dumps({"warning": "AKShare wrapper failed; using its Eastmoney source with endpoint rotation",
                          "error": str(primary_error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        return fetch_eastmoney_rank_fallback()


def resolve_daily_trade_date(connection: pymysql.Connection, requested: str | None) -> str:
    if requested:
        return normalize_date(requested)
    today = date.today().isoformat()
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT trade_date FROM trading_calendar WHERE market='SH' AND trade_date=%s AND is_open=1 LIMIT 1",
            (today,),
        )
        if cursor.fetchone():
            return today
        cursor.execute("SELECT MAX(trade_date) AS trade_date FROM daily_bars_v2 WHERE trade_date<=%s", (today,))
        value = cursor.fetchone()["trade_date"]
    if value is None:
        raise RuntimeError("cannot resolve a completed trade date")
    return value.isoformat() if isinstance(value, date) else str(value)[:10]


def run_akshare_daily(args: argparse.Namespace) -> int:
    connection = connect_db()
    progress = Path(args.progress_file)
    try:
        _, by_symbol_market = load_instruments(connection)
        trade_date = resolve_daily_trade_date(connection, args.trade_date)
        write_progress(progress, status="running", phase="akshare-daily", completed=0,
                       total=1, failed=0, inserted=0, currentDate=trade_date)
        frame = call_with_retries(
            fetch_akshare_daily_frame,
            args.attempts,
            args.retry_delay,
        )
        fetched_at = datetime.now(UTC).replace(tzinfo=None)
        records = []
        unmatched = 0
        invalid = 0
        for row in frame.itertuples(index=False, name=None):
            symbol = str(row[1]).split(".")[0].zfill(6)
            instrument = by_symbol_market.get(f"{infer_market(symbol)}:{symbol}")
            if not instrument:
                unmatched += 1
                continue
            try:
                records.append(akshare_record(list(row), instrument.instrument_key, trade_date, fetched_at))
            except ValueError:
                invalid += 1
        expected = len([item for item in by_symbol_market.values() if item.market in {"SH", "SZ", "BJ"}])
        coverage = len(records) / expected if expected else 0
        if coverage < args.min_coverage:
            raise RuntimeError(
                f"coverage {coverage:.2%} below {args.min_coverage:.2%} "
                f"(records={len(records)}, instruments={expected}, unmatched={unmatched}, invalid={invalid})"
            )
        inserted = upsert_records(connection, records)
        write_progress(progress, status="completed", phase="akshare-daily", completed=1,
                       total=1, failed=0, inserted=inserted, currentDate=trade_date,
                       coverage=round(coverage, 4))
        print(json.dumps({"date": trade_date, "rows": inserted, "coverage": round(coverage, 4),
                          "unmatched": unmatched, "invalid": invalid}, ensure_ascii=False))
        return 0
    except Exception as exc:
        connection.rollback()
        write_progress(progress, status="failed", phase="akshare-daily", completed=0,
                       total=1, failed=1, inserted=0, currentDate=args.trade_date, message=str(exc))
        raise
    finally:
        connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backfill and update A-share stock fund-flow data")
    subparsers = parser.add_subparsers(dest="command", required=True)
    backfill = subparsers.add_parser("backfill", help="backfill history from Tinyshare")
    backfill.add_argument("--start-date", default="2010-01-01")
    backfill.add_argument("--end-date", default=date.today().isoformat())
    backfill.add_argument("--min-source-coverage", type=float, default=0.90)
    backfill.add_argument("--attempts", type=int, default=4)
    backfill.add_argument("--retry-delay", type=float, default=2.0)
    backfill.add_argument("--request-interval", type=float, default=0.3)
    backfill.add_argument("--continue-on-error", action="store_true")
    backfill.add_argument("--progress-file", default=str(DEFAULT_PROGRESS))
    daily = subparsers.add_parser("daily", help="update one completed trade date from AKShare")
    daily.add_argument("--trade-date")
    daily.add_argument("--min-coverage", type=float, default=0.85)
    daily.add_argument("--attempts", type=int, default=4)
    daily.add_argument("--retry-delay", type=float, default=5.0)
    daily.add_argument("--progress-file", default=str(DEFAULT_PROGRESS))
    return parser


def main() -> int:
    load_env()
    args = build_parser().parse_args()
    if args.command == "backfill":
        return run_tinyshare_backfill(args)
    return run_akshare_daily(args)


if __name__ == "__main__":
    raise SystemExit(main())
