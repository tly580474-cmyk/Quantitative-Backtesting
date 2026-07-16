from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import akshare as ak
import pandas as pd
import pymysql


TASK_KEY = "dividend-history-akshare-em"


@dataclass(frozen=True)
class Instrument:
    instrument_key: int
    symbol: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recoverable A-share dividend history updater")
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--symbol", help="update one symbol without changing the backfill queue")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    connection = open_database()
    results = []
    failures = []
    try:
        instruments = (
            load_symbol(connection, args.symbol)
            if args.symbol else load_backfill_batch(connection, max(1, args.batch_size))
        )
        if args.dry_run:
            print(json.dumps({
                "status": "planned",
                "symbols": [item.symbol for item in instruments],
                "count": len(instruments),
            }, ensure_ascii=False))
            return 0
        with ThreadPoolExecutor(max_workers=min(max(1, args.workers), max(1, len(instruments)))) as executor:
            futures = {
                executor.submit(ak.stock_fhps_detail_em, symbol=instrument.symbol): instrument
                for instrument in instruments
            }
            fetched = []
            for future in as_completed(futures):
                instrument = futures[future]
                try:
                    fetched.append((instrument, future.result(), None))
                except Exception as error:
                    fetched.append((instrument, None, error))
        for instrument, frame, fetch_error in fetched:
            try:
                if fetch_error is not None:
                    raise fetch_error
                assert frame is not None
                events = normalize_dividend_events(frame, instrument)
                publish_events(connection, instrument, events)
                if not args.symbol:
                    mark_backfill(connection, instrument.instrument_key, "completed", None)
                results.append({"symbol": instrument.symbol, "events": len(events)})
            except Exception as error:
                message = str(error)[:1000]
                if not args.symbol:
                    mark_backfill(connection, instrument.instrument_key, "failed", message)
                failures.append({"symbol": instrument.symbol, "error": message})
    finally:
        connection.close()
    print(json.dumps({
        "status": "ready" if not failures else "partial",
        "completed": len(results),
        "failed": len(failures),
        "itemSamples": results[:20],
        "failures": failures[:20],
    }, ensure_ascii=False))
    return 0 if results or not failures else 2


def normalize_dividend_events(frame: pd.DataFrame, instrument: Instrument) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    required = ("报告期", "现金分红-现金分红比例", "送转股份-送股比例", "送转股份-转股比例")
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise RuntimeError("dividend source missing columns: " + ", ".join(missing))
    events = []
    for _, row in frame.iterrows():
        report_period = optional_date(row.get("报告期"))
        if not report_period:
            continue
        cash = per_ten_to_per_share(row.get("现金分红-现金分红比例"))
        bonus = per_ten_to_per_share(row.get("送转股份-送股比例"))
        transfer = per_ten_to_per_share(row.get("送转股份-转股比例"))
        raw_plan = optional_text(row.get("现金分红-现金分红比例描述"))
        fingerprint_payload = "|".join([
            str(instrument.instrument_key), report_period,
            optional_date(row.get("除权除息日")) or "",
            "" if cash is None else format(cash, ".12g"),
            "" if bonus is None else format(bonus, ".12g"),
            "" if transfer is None else format(transfer, ".12g"),
            raw_plan or "",
        ])
        fingerprint = hashlib.sha256(fingerprint_payload.encode("utf-8")).hexdigest()
        events.append({
            "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, fingerprint)),
            "instrument_key": instrument.instrument_key,
            "report_period": report_period,
            "disclosure_date": optional_date(row.get("业绩披露日期")),
            "announcement_date": optional_date(row.get("预案公告日")),
            "record_date": optional_date(row.get("股权登记日")),
            "ex_date": optional_date(row.get("除权除息日")),
            "latest_announcement_date": optional_date(row.get("最新公告日期")),
            "cash_dividend_per_share": cash,
            "bonus_share_per_share": bonus,
            "transfer_share_per_share": transfer,
            "dividend_yield_raw": optional_float(row.get("现金分红-股息率")),
            "plan_status": optional_text(row.get("方案进度")),
            "raw_plan": raw_plan,
            "source_fingerprint": fingerprint,
        })
    return events


def publish_events(connection, instrument: Instrument, events: list[dict[str, Any]]) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with connection.cursor() as cursor:
        for event in events:
            cursor.execute(
                """
                INSERT INTO dividend_events
                  (event_id, instrument_key, report_period, disclosure_date, announcement_date,
                   record_date, ex_date, latest_announcement_date, cash_dividend_per_share,
                   bonus_share_per_share, transfer_share_per_share, dividend_yield_raw,
                   plan_status, raw_plan, source_key, source_fingerprint, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        'akshare:stock_fhps_detail_em', %s, %s)
                ON DUPLICATE KEY UPDATE
                  disclosure_date=VALUES(disclosure_date), announcement_date=VALUES(announcement_date),
                  record_date=VALUES(record_date), ex_date=VALUES(ex_date),
                  latest_announcement_date=VALUES(latest_announcement_date),
                  plan_status=VALUES(plan_status), raw_plan=VALUES(raw_plan), fetched_at=VALUES(fetched_at)
                """,
                (
                    event["event_id"], event["instrument_key"], event["report_period"],
                    event["disclosure_date"], event["announcement_date"], event["record_date"],
                    event["ex_date"], event["latest_announcement_date"],
                    event["cash_dividend_per_share"], event["bonus_share_per_share"],
                    event["transfer_share_per_share"], event["dividend_yield_raw"],
                    event["plan_status"], event["raw_plan"], event["source_fingerprint"], now,
                ),
            )
    connection.commit()


def load_backfill_batch(connection, batch_size: int) -> list[Instrument]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT instrument.instrument_key, instrument.symbol
            FROM instruments AS instrument
            LEFT JOIN reference_data_backfill_items AS item
              ON item.task_key=%s AND item.instrument_key=instrument.instrument_key
            WHERE instrument.type='stock'
              AND (item.status IS NULL OR item.status<>'completed')
            ORDER BY (item.status='failed'), instrument.instrument_key
            LIMIT %s
            """,
            (TASK_KEY, batch_size),
        )
        instruments = [Instrument(int(key), str(symbol).zfill(6)) for key, symbol in cursor.fetchall()]
        remaining = batch_size - len(instruments)
        if remaining > 0:
            selected_keys = [item.instrument_key for item in instruments]
            exclusion = ""
            parameters: list[Any] = [TASK_KEY]
            if selected_keys:
                placeholders = ",".join(["%s"] * len(selected_keys))
                exclusion = f" AND instrument.instrument_key NOT IN ({placeholders})"
                parameters.extend(selected_keys)
            parameters.append(remaining)
            cursor.execute(
                f"""
                SELECT instrument.instrument_key, instrument.symbol
                FROM instruments AS instrument
                INNER JOIN reference_data_backfill_items AS item
                  ON item.task_key=%s AND item.instrument_key=instrument.instrument_key
                WHERE instrument.type='stock' AND item.status='completed'{exclusion}
                ORDER BY item.updated_at, instrument.instrument_key
                LIMIT %s
                """,
                parameters,
            )
            instruments.extend(
                Instrument(int(key), str(symbol).zfill(6)) for key, symbol in cursor.fetchall()
            )
        return instruments


def load_symbol(connection, symbol: str | None) -> list[Instrument]:
    if not symbol:
        return []
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT instrument_key, symbol FROM instruments WHERE symbol=%s AND type='stock' LIMIT 1",
            (symbol.zfill(6),),
        )
        row = cursor.fetchone()
        if not row:
            raise RuntimeError(f"unknown stock symbol: {symbol}")
        return [Instrument(int(row[0]), str(row[1]).zfill(6))]


def mark_backfill(connection, instrument_key: int, status: str, error: str | None) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO reference_data_backfill_items
              (task_key, instrument_key, status, attempts, last_error, updated_at)
            VALUES (%s, %s, %s, 1, %s, UTC_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE
              status=VALUES(status), attempts=attempts+1, last_error=VALUES(last_error),
              updated_at=VALUES(updated_at)
            """,
            (TASK_KEY, instrument_key, status, error),
        )
    connection.commit()


def per_ten_to_per_share(value: Any) -> float | None:
    number = optional_float(value)
    return None if number is None else number / 10.0


def optional_float(value: Any) -> float | None:
    if value is None or pd.isna(value) or str(value).strip() in ("", "-", "--"):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def optional_date(value: Any) -> str | None:
    if value is None or pd.isna(value) or str(value).strip() in ("", "-", "--"):
        return None
    parsed = pd.to_datetime(value, errors="coerce")
    return None if pd.isna(parsed) else parsed.strftime("%Y-%m-%d")


def optional_text(value: Any) -> str | None:
    if value is None or pd.isna(value):
        return None
    text = str(value).strip()
    return None if text in ("", "-", "--") else text


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def open_database():
    return pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"), port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"), charset="utf8mb4", autocommit=False,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        raise
