from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from update import (
    EXPECTED_COLUMNS,
    file_crc32,
    iso_add_days,
    latest_finalized_date,
    load_env_file,
    publish_manifest,
    validate_date,
)


@dataclass(frozen=True)
class Instrument:
    symbol: str
    market: str
    list_date: str | None
    delist_date: str | None

    @property
    def provider_symbol(self) -> str:
        return f"{self.symbol}.{self.market}"


@dataclass(frozen=True)
class DailyReference:
    previous_close: float | None
    open: float
    high: float
    low: float
    close: float
    volume: float
    amount: float | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import locally downloaded TongdaXin .lc1 files into the minute Parquet lake",
    )
    parser.add_argument("--tdx-root", default=os.getenv("TDX_DATA_ROOT", "D:/tdx"))
    parser.add_argument(
        "--output-root",
        default=os.getenv("MINUTE_DATA_ROOT", "../../所有股票的历史数据/1m_price_parquet"),
    )
    parser.add_argument("--start-date", help="YYYY-MM-DD; defaults to manifest.lastDate + 1")
    parser.add_argument("--end-date", help="YYYY-MM-DD; defaults to the latest finalized local TDX date")
    parser.add_argument("--batch-symbols", type=int, default=50)
    parser.add_argument("--probe-symbol", help="Only validate one symbol without writing files")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env_file(Path.cwd() / ".env")
    args = parse_args()
    tdx_root = Path(args.tdx_root).resolve()
    output_root = Path(args.output_root).resolve()
    manifest_path = output_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_last_date = max(str(item["date"]) for item in manifest["files"])
    local_last_date = detect_local_last_date(tdx_root)
    finalized = latest_finalized_date()
    default_end = min(local_last_date, finalized)
    start_date = validate_date(args.start_date) if args.start_date else iso_add_days(manifest_last_date, 1)
    end_date = validate_date(args.end_date) if args.end_date else default_end
    connection = open_database()
    try:
        expected_last_date = load_latest_trading_date(connection, finalized)
        if start_date > end_date:
            status = classify_idle_status(local_last_date, expected_last_date)
            print(json.dumps({
                "status": status,
                "manifestLastDate": manifest_last_date,
                "localLastDate": local_last_date,
                "expectedLastTradingDate": expected_last_date,
                "latestFinalizedDate": finalized,
            }, ensure_ascii=False))
            return 2 if status == "source-stale" else 0
        trading_dates = load_trading_dates(connection, start_date, end_date)
        instruments = load_instruments(connection, start_date, end_date)
        references = load_daily_references(connection, start_date, end_date)
    finally:
        connection.close()
    existing_dates = {str(item["date"]) for item in manifest["files"]}
    pending_dates = [
        item for item in trading_dates
        if args.overwrite or item not in existing_dates
    ]
    available_files = sum(int(tdx_path(tdx_root, item).is_file()) for item in instruments)
    summary = {
        "tdxRoot": str(tdx_root),
        "outputRoot": str(output_root),
        "manifestLastDate": manifest_last_date,
        "localLastDate": local_last_date,
        "startDate": start_date,
        "endDate": end_date,
        "tradingDates": len(trading_dates),
        "pendingDates": len(pending_dates),
        "instruments": len(instruments),
        "availableLc1Files": available_files,
    }
    if args.dry_run:
        print(json.dumps({"status": "planned", **summary}, ensure_ascii=False))
        return 0
    if args.probe_symbol:
        result = probe_symbol(
            tdx_root, instruments, references, args.probe_symbol, start_date, end_date,
        )
        print(json.dumps({"status": "probe-passed", **summary, **result}, ensure_ascii=False))
        return 0
    if not pending_dates:
        print(json.dumps({"status": "up-to-date", **summary}, ensure_ascii=False))
        return 0

    result = import_dates(
        tdx_root=tdx_root,
        output_root=output_root,
        manifest=manifest,
        instruments=instruments,
        references=references,
        pending_dates=pending_dates,
        batch_symbols=max(1, args.batch_symbols),
        overwrite=args.overwrite,
    )
    print(json.dumps({"status": "ready", **summary, **result}, ensure_ascii=False))
    return 0


def detect_local_last_date(tdx_root: Path) -> str:
    from mootdx.reader import TdxLCMinBarReader

    candidates = [
        tdx_root / "vipdoc/sz/minline/sz000001.lc1",
        tdx_root / "vipdoc/sh/minline/sh600000.lc1",
        tdx_root / "vipdoc/bj/minline/bj920992.lc1",
    ]
    last_dates: list[str] = []
    reader = TdxLCMinBarReader()
    for path in candidates:
        if not path.is_file():
            continue
        frame = reader.get_df(str(path))
        if frame is not None and not frame.empty:
            last_dates.append(frame.index.max().date().isoformat())
    if not last_dates:
        raise RuntimeError(f"{tdx_root} 下找不到可读取的 .lc1 分钟文件")
    return max(last_dates)


def open_database():
    try:
        import pymysql
    except ImportError as error:
        raise RuntimeError(
            "缺少 pymysql；请执行 python -m pip install -r src/minuteData/requirements.txt",
        ) from error
    return pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"),
        cursorclass=pymysql.cursors.DictCursor,
    )


def load_trading_dates(connection, start_date: str, end_date: str) -> list[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DISTINCT DATE_FORMAT(b.trade_date, '%%Y-%%m-%%d') AS trade_date
            FROM daily_bars_v2 b
            WHERE b.trade_date BETWEEN %s AND %s AND b.is_final = 1
            ORDER BY trade_date
            """,
            (start_date, end_date),
        )
        return [str(row["trade_date"]) for row in cursor.fetchall()]


def load_latest_trading_date(connection, end_date: str) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DATE_FORMAT(MAX(trade_date), '%%Y-%%m-%%d') AS trade_date
            FROM daily_bars_v2
            WHERE trade_date <= %s AND is_final = 1
            """,
            (end_date,),
        )
        row = cursor.fetchone()
    if not row or not row["trade_date"]:
        raise RuntimeError(f"数据库中找不到 {end_date} 以前的最终日线交易日")
    return str(row["trade_date"])


def load_instruments(connection, start_date: str, end_date: str) -> list[Instrument]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT symbol, market, list_date, delist_date
            FROM instruments
            WHERE type = 'stock'
              AND COALESCE(list_date, '1900-01-01') <= %s
              AND (delist_date IS NULL OR delist_date >= %s)
              AND market IN ('SH', 'SZ', 'BJ')
            ORDER BY symbol, market
            """,
            (end_date, start_date),
        )
        return [Instrument(
            symbol=str(row["symbol"]),
            market=str(row["market"]),
            list_date=str(row["list_date"]) if row["list_date"] else None,
            delist_date=str(row["delist_date"]) if row["delist_date"] else None,
        ) for row in cursor.fetchall()]


def load_daily_references(
    connection,
    start_date: str,
    end_date: str,
) -> dict[tuple[str, str], DailyReference]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT CONCAT(i.symbol, '.', i.market) AS provider_symbol,
                   DATE_FORMAT(b.trade_date, '%%Y-%%m-%%d') AS trade_date,
                   b.previous_close, b.open, b.high, b.low, b.close, b.volume, b.amount
            FROM daily_bars_v2 b
            JOIN instruments i ON i.instrument_key = b.instrument_key
            WHERE i.type = 'stock'
              AND b.trade_date BETWEEN %s AND %s
              AND b.is_final = 1
            """,
            (start_date, end_date),
        )
        result: dict[tuple[str, str], DailyReference] = {}
        for row in cursor.fetchall():
            result[(str(row["provider_symbol"]), str(row["trade_date"]))] = DailyReference(
                previous_close=optional_float(row["previous_close"]),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row["volume"] or 0),
                amount=optional_float(row["amount"]),
            )
        return result


def tdx_path(tdx_root: Path, instrument: Instrument) -> Path:
    market = instrument.market.lower()
    return tdx_root / "vipdoc" / market / "minline" / f"{market}{instrument.symbol}.lc1"


def read_tdx_minutes(path: Path):
    from mootdx.reader import TdxLCMinBarReader

    if not path.is_file():
        return None
    return TdxLCMinBarReader().get_df(str(path))


def normalize_instrument_minutes(
    instrument: Instrument,
    raw,
    references: dict[tuple[str, str], DailyReference],
    start_date: str,
    end_date: str,
):
    import pandas as pd

    if raw is None or raw.empty:
        return []
    frame = raw.sort_index().reset_index().rename(columns={"date": "timestamp", "volume": "vol"})
    frame["trade_date"] = frame["timestamp"].dt.strftime("%Y-%m-%d")
    frame["pre_close"] = frame["close"].shift(1)
    frame = frame[(frame["trade_date"] >= start_date) & (frame["trade_date"] <= end_date)].copy()
    results = []
    for trade_date, group in frame.groupby("trade_date", sort=True):
        group = group.sort_values("timestamp").copy()
        if not instrument_active_on(instrument, trade_date):
            continue
        reference = references.get((instrument.provider_symbol, trade_date))
        if reference is None:
            if float(group["vol"].sum()) == 0 and float(group["amount"].sum()) == 0:
                # TDX keeps 240 flat placeholder bars for some suspended stocks.
                # Without a finalized daily bar, these are not tradable observations.
                continue
        if len(group) != 240:
            raise RuntimeError(
                f"{instrument.provider_symbol} {trade_date} 有 {len(group)} 根，期望 240 根",
            )
        first_pre_close = optional_float(group.iloc[0]["pre_close"])
        if reference is not None and reference.previous_close is not None:
            first_pre_close = reference.previous_close
        if first_pre_close is None:
            first_pre_close = float(group.iloc[0]["open"])
        group.iloc[0, group.columns.get_loc("pre_close")] = first_pre_close
        group["change"] = group["close"] - group["pre_close"]
        group["pct_chg"] = group["change"] / group["pre_close"] * 100
        group.loc[group["pre_close"] == 0, "pct_chg"] = math.nan
        group["code"] = instrument.provider_symbol
        group["trade_time"] = group["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
        group["date"] = trade_date.replace("-", "")
        group["__index_level_0__"] = range(len(group))
        daily_verified = reference is not None and validate_against_daily(
            instrument.provider_symbol, trade_date, group, reference,
        )
        result_frame = group[EXPECTED_COLUMNS]
        result_frame.attrs["daily_verified"] = daily_verified
        results.append((trade_date, result_frame))
    return results


def validate_against_daily(
    provider_symbol: str,
    trade_date: str,
    frame,
    reference: DailyReference,
) -> bool:
    actual = {
        "open": float(frame.iloc[0]["open"]),
        "high": float(frame["high"].max()),
        "low": float(frame["low"].min()),
        "close": float(frame.iloc[-1]["close"]),
        "volume": float(frame["vol"].sum()),
        "amount": float(frame["amount"].sum()),
    }
    # Native TDX minutes start at 09:31. The daily open/high/low may include the
    # 09:25 call auction, so only the close can be required to match exactly.
    close_ok = abs(actual["close"] - reference.close) <= 0.0051
    volume_ok = abs(actual["volume"] - reference.volume) <= 0.5
    # The current daily database stores STAR Market volume 100x larger than
    # its amount-implied share count. Keep TDX minutes in shares and accept
    # that known reference-unit mismatch instead of multiplying source data.
    if provider_symbol.startswith("688") and provider_symbol.endswith(".SH"):
        star_volume_difference = abs(actual["volume"] * 100 - reference.volume)
        volume_ok = volume_ok or star_volume_difference <= max(
            5_000.0, abs(reference.volume) * 0.001,
        )
    amount_ok = reference.amount is None or (
        abs(actual["amount"] - reference.amount)
        <= max(5_000.0, abs(reference.amount) * 0.001)
    )
    if not close_ok:
        raise RuntimeError(
            f"{provider_symbol} {trade_date} 与日线不一致："
            f"close={close_ok}, volume={volume_ok}, amount={amount_ok}",
        )
    return volume_ok and amount_ok


def probe_symbol(
    tdx_root: Path,
    instruments: list[Instrument],
    references: dict[tuple[str, str], DailyReference],
    symbol: str,
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    normalized = symbol.strip().upper().split(".")[0]
    matches = [item for item in instruments if item.symbol == normalized]
    if len(matches) != 1:
        raise RuntimeError(f"找不到唯一股票：{symbol}")
    instrument = matches[0]
    groups = normalize_instrument_minutes(
        instrument, read_tdx_minutes(tdx_path(tdx_root, instrument)),
        references, start_date, end_date,
    )
    if not groups:
        raise RuntimeError(f"{instrument.provider_symbol} 在指定范围内没有分钟数据")
    return {
        "providerSymbol": instrument.provider_symbol,
        "validatedDates": len(groups),
        "firstDate": groups[0][0],
        "lastDate": groups[-1][0],
        "rows": sum(len(frame) for _, frame in groups),
        "unverifiedDailyChecks": sum(
            not frame.attrs.get("daily_verified", False) for _, frame in groups
        ),
    }


def import_dates(
    *,
    tdx_root: Path,
    output_root: Path,
    manifest: dict[str, Any],
    instruments: list[Instrument],
    references: dict[tuple[str, str], DailyReference],
    pending_dates: list[str],
    batch_symbols: int,
    overwrite: bool,
) -> dict[str, Any]:
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    schema = minute_arrow_schema(pa)
    pending_set = set(pending_dates)
    buffers: dict[str, list[Any]] = defaultdict(list)
    writers: dict[str, Any] = {}
    temporary_paths: dict[str, Path] = {}
    seen_symbols: dict[str, set[str]] = defaultdict(set)
    errors: list[str] = []
    unverified: list[str] = []
    coverage_missing: list[str] = []
    started = time.monotonic()

    def flush(trade_date: str) -> None:
        frames = buffers.pop(trade_date, [])
        if not frames:
            return
        combined = pd.concat(frames, ignore_index=True).sort_values(["code", "trade_time"])
        for column in ("close", "open", "high", "low", "vol", "amount", "pre_close", "change", "pct_chg"):
            combined[column] = combined[column].astype("float32")
        combined["__index_level_0__"] = combined["__index_level_0__"].astype("int64")
        table = pa.Table.from_pandas(combined[EXPECTED_COLUMNS], schema=schema, preserve_index=False)
        writers[trade_date].write_table(table)

    try:
        for trade_date in pending_dates:
            target = output_root / f"year={trade_date[:4]}" / f"{trade_date.replace('-', '')}.parquet"
            if target.exists() and not overwrite:
                raise RuntimeError(f"目标文件已存在但 manifest 未登记：{target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(".parquet.tdx-partial")
            temporary.unlink(missing_ok=True)
            temporary_paths[trade_date] = temporary
            writers[trade_date] = pq.ParquetWriter(temporary, schema, compression="snappy")

        for completed, instrument in enumerate(instruments, start=1):
            path = tdx_path(tdx_root, instrument)
            if not path.is_file():
                continue
            try:
                groups = normalize_instrument_minutes(
                    instrument, read_tdx_minutes(path), references,
                    pending_dates[0], pending_dates[-1],
                )
                for trade_date, frame in groups:
                    if trade_date not in pending_set:
                        continue
                    buffers[trade_date].append(frame)
                    seen_symbols[trade_date].add(instrument.provider_symbol)
                    if not frame.attrs.get("daily_verified", False):
                        unverified.append(f"{instrument.provider_symbol}:{trade_date}")
            except Exception as error:
                errors.append(str(error))
                print(json.dumps({
                    "status": "validation-error",
                    "providerSymbol": instrument.provider_symbol,
                    "error": str(error),
                }, ensure_ascii=False), flush=True)
            if completed % batch_symbols == 0:
                for trade_date in pending_dates:
                    flush(trade_date)
            if completed % 250 == 0 or completed == len(instruments):
                print(json.dumps({
                    "status": "reading-tdx",
                    "completedInstruments": completed,
                    "totalInstruments": len(instruments),
                    "errors": len(errors),
                    "unverifiedDailyChecks": len(unverified),
                    "elapsedSeconds": round(time.monotonic() - started, 1),
                }, ensure_ascii=False), flush=True)
        for trade_date in pending_dates:
            flush(trade_date)
        if errors:
            raise RuntimeError(
                f"TDX 标准化或日线对账失败 {len(errors)} 项：" + "; ".join(errors[:10]),
            )
        for trade_date in pending_dates:
            expected_traded = {
                symbol for (symbol, day), reference in references.items()
                if day == trade_date and reference.volume > 0
            }
            missing = expected_traded - seen_symbols[trade_date]
            if missing:
                coverage_missing.extend(
                    f"{symbol}:{trade_date}" for symbol in sorted(missing)
                )
                print(json.dumps({
                    "status": "coverage-warning",
                    "date": trade_date,
                    "missingTradedSymbols": len(missing),
                    "samples": sorted(missing)[:20],
                }, ensure_ascii=False), flush=True)
    except Exception:
        for writer in writers.values():
            try:
                writer.close()
            except Exception:
                pass
        for path in temporary_paths.values():
            path.unlink(missing_ok=True)
        raise
    else:
        for writer in writers.values():
            writer.close()

    published_rows = 0
    published_bytes = 0
    for trade_date in pending_dates:
        temporary = temporary_paths[trade_date]
        parquet = pq.ParquetFile(temporary)
        expected_rows = len(seen_symbols[trade_date]) * 240
        actual_rows = parquet.metadata.num_rows
        actual_columns = parquet.schema_arrow.names
        del parquet
        if actual_rows != expected_rows:
            raise RuntimeError(
                f"{trade_date} 写盘行数 {actual_rows} != {expected_rows}",
            )
        if actual_columns != EXPECTED_COLUMNS:
            raise RuntimeError(f"{trade_date} 写盘字段不一致")
        target = output_root / f"year={trade_date[:4]}" / f"{trade_date.replace('-', '')}.parquet"
        os.replace(temporary, target)
        entry = {
            "date": trade_date,
            "relativePath": f"year={trade_date[:4]}/{target.name}",
            "bytes": target.stat().st_size,
            "crc32": file_crc32(target),
            "source": "tdx-local:lc1",
        }
        publish_manifest(output_root, manifest, entry)
        published_rows += actual_rows
        published_bytes += entry["bytes"]
        print(json.dumps({
            "status": "published",
            "date": trade_date,
            "symbols": len(seen_symbols[trade_date]),
            "rows": actual_rows,
            "bytes": entry["bytes"],
        }, ensure_ascii=False), flush=True)
    return {
        "publishedDates": len(pending_dates),
        "publishedRows": published_rows,
        "publishedBytes": published_bytes,
        "elapsedSeconds": round(time.monotonic() - started, 1),
        "unverifiedDailyChecks": len(unverified),
        "unverifiedSamples": unverified[:20],
        "coverageMissing": len(coverage_missing),
        "coverageMissingSamples": coverage_missing[:20],
    }


def minute_arrow_schema(pa):
    return pa.schema([
        ("code", pa.string()),
        ("trade_time", pa.string()),
        ("close", pa.float32()),
        ("open", pa.float32()),
        ("high", pa.float32()),
        ("low", pa.float32()),
        ("vol", pa.float32()),
        ("amount", pa.float32()),
        ("date", pa.string()),
        ("pre_close", pa.float32()),
        ("change", pa.float32()),
        ("pct_chg", pa.float32()),
        ("__index_level_0__", pa.int64()),
    ])


def instrument_active_on(instrument: Instrument, trade_date: str) -> bool:
    return (
        (instrument.list_date is None or instrument.list_date <= trade_date)
        and (instrument.delist_date is None or instrument.delist_date >= trade_date)
    )


def classify_idle_status(local_last_date: str, expected_last_date: str) -> str:
    return "source-stale" if local_last_date < expected_last_date else "up-to-date"


def optional_float(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
