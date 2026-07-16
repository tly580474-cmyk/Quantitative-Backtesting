from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import akshare as ak
import pandas as pd
import pymysql


@dataclass(frozen=True)
class IndexDefinition:
    code: str
    name: str
    provider_symbol: str


TARGETS = {
    item.code: item
    for item in (
        IndexDefinition("000001", "上证指数", "sh000001"),
        IndexDefinition("399001", "深证成指", "sz399001"),
        IndexDefinition("399006", "创业板指", "sz399006"),
        IndexDefinition("000300", "沪深300", "sh000300"),
        IndexDefinition("000905", "中证500", "sh000905"),
        IndexDefinition("000852", "中证1000", "sh000852"),
        IndexDefinition("932000", "中证2000", "csi932000"),
        IndexDefinition("000688", "科创50", "sh000688"),
        IndexDefinition("000680", "科创综指", "sh000680"),
    )
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill and incrementally update core index daily bars")
    parser.add_argument("--symbols", default=",".join(TARGETS), help="comma-separated index codes")
    parser.add_argument("--start-date", default="19900101")
    parser.add_argument("--end-date", default=date.today().strftime("%Y%m%d"))
    parser.add_argument("--full", action="store_true", help="refetch the requested full date range")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    symbols = [item.strip() for item in args.symbols.split(",") if item.strip()]
    unknown = [item for item in symbols if item not in TARGETS]
    if unknown:
        raise RuntimeError("unsupported index codes: " + ", ".join(unknown))

    connection = open_database()
    results = []
    failures = []
    try:
        for symbol in symbols:
            definition = TARGETS[symbol]
            dataset = load_dataset(connection, symbol)
            start_date = args.start_date
            if not args.full and dataset and dataset["end_time"]:
                start_date = next_date(str(dataset["end_time"]))
            if start_date > args.end_date:
                results.append({"symbol": symbol, "status": "up-to-date", "endDate": dataset["end_time"]})
                continue
            try:
                frame = fetch_index_frame_with_retry(definition, start_date, args.end_date)
            except Exception as error:
                if dataset:
                    results.append({
                        "symbol": symbol,
                        "status": "cached-fallback",
                        "endDate": str(dataset["end_time"]),
                        "warning": str(error)[:500],
                    })
                    continue
                failures.append({"symbol": symbol, "error": str(error)[:500]})
                continue
            if frame.empty:
                results.append({"symbol": symbol, "status": "no-new-bars", "startDate": start_date})
                continue
            validate_index_frame(frame, definition.code)
            if args.dry_run:
                results.append({
                    "symbol": symbol,
                    "status": "planned",
                    "rows": len(frame),
                    "minDate": frame.iloc[0]["tradeDate"],
                    "maxDate": frame.iloc[-1]["tradeDate"],
                })
                continue
            dataset_id = dataset["id"] if dataset else str(uuid.uuid4())
            upsert_index_frame(connection, dataset_id, definition, frame, dataset is None)
            results.append({
                "symbol": symbol,
                "status": "updated",
                "rows": len(frame),
                "minDate": frame.iloc[0]["tradeDate"],
                "maxDate": frame.iloc[-1]["tradeDate"],
            })
    finally:
        connection.close()
    print(json.dumps({
        "status": "ready" if not failures else "partial",
        "items": results,
        "failures": failures,
    }, ensure_ascii=False))
    return 0 if not failures else 2


def fetch_index_frame_with_retry(
    definition: IndexDefinition,
    start_date: str,
    end_date: str,
    attempts: int = 3,
) -> pd.DataFrame:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fetch_index_frame(definition, start_date, end_date)
        except Exception as error:
            last_error = error
            if attempt < attempts:
                time.sleep(attempt)
    assert last_error is not None
    raise last_error


def fetch_index_frame(definition: IndexDefinition, start_date: str, end_date: str) -> pd.DataFrame:
    raw = ak.stock_zh_index_daily_em(
        symbol=definition.provider_symbol,
        start_date=start_date.replace("-", ""),
        end_date=end_date.replace("-", ""),
    )
    if raw.empty:
        return pd.DataFrame(columns=[
            "tradeDate", "open", "high", "low", "close", "volume", "amount",
            "change", "changePercent",
        ])
    frame = raw.rename(columns={
        "date": "tradeDate",
        "open": "open",
        "high": "high",
        "low": "low",
        "close": "close",
        "volume": "volume",
        "amount": "amount",
    }).copy()
    frame["tradeDate"] = pd.to_datetime(frame["tradeDate"], errors="raise").dt.strftime("%Y-%m-%d")
    for column in ("open", "high", "low", "close", "volume", "amount"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    previous = frame["close"].shift(1)
    frame["change"] = frame["close"] - previous
    frame["changePercent"] = frame["change"] / previous * 100
    return frame[[
        "tradeDate", "open", "high", "low", "close", "volume", "amount",
        "change", "changePercent",
    ]].sort_values("tradeDate").drop_duplicates("tradeDate", keep="last").reset_index(drop=True)


def validate_index_frame(frame: pd.DataFrame, symbol: str) -> None:
    if frame.empty:
        return
    if frame["tradeDate"].duplicated().any():
        raise RuntimeError(f"{symbol} contains duplicate dates")
    for column in ("open", "high", "low", "close", "volume", "amount"):
        values = frame[column]
        if values.isna().any() or not values.map(math.isfinite).all():
            raise RuntimeError(f"{symbol} {column} contains invalid values")
    if (frame[["open", "high", "low", "close"]] <= 0).any().any():
        raise RuntimeError(f"{symbol} contains non-positive prices")
    if (frame["high"] < frame[["open", "close"]].max(axis=1)).any():
        raise RuntimeError(f"{symbol} contains invalid highs")
    if (frame["low"] > frame[["open", "close"]].min(axis=1)).any():
        raise RuntimeError(f"{symbol} contains invalid lows")
    if (frame[["volume", "amount"]] < 0).any().any():
        raise RuntimeError(f"{symbol} contains negative volume or amount")


def upsert_index_frame(connection, dataset_id: str, definition: IndexDefinition, frame: pd.DataFrame, create: bool) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    rows = [
        (
            dataset_id,
            row.tradeDate,
            definition.code,
            float(row.open),
            float(row.high),
            float(row.low),
            float(row.close),
            optional_float(row.change),
            optional_float(row.changePercent),
            float(row.volume),
            float(row.amount),
        )
        for row in frame.itertuples(index=False)
    ]
    with connection.cursor() as cursor:
        if create:
            cursor.execute(
                """
                INSERT INTO market_datasets
                  (id, symbol, asset_type, checksum, name, timeframe, start_time, end_time,
                   count, source_file_name, created_at, updated_at)
                VALUES (%s, %s, 'index', %s, %s, '1d', %s, %s, 0,
                        'akshare:stock_zh_index_daily_em', %s, %s)
                """,
                (dataset_id, definition.code, f"pending-{dataset_id}", definition.name,
                 frame.iloc[0]["tradeDate"], frame.iloc[-1]["tradeDate"], now, now),
            )
        cursor.executemany(
            """
            INSERT INTO candles
              (dataset_id, time, symbol, open, high, low, close, `change`, change_percent,
               volume, turnover)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close),
              `change`=VALUES(`change`), change_percent=VALUES(change_percent),
              volume=VALUES(volume), turnover=VALUES(turnover)
            """,
            rows,
        )
        cursor.execute(
            """
            SELECT COUNT(*), MIN(time), MAX(time)
            FROM candles
            WHERE dataset_id=%s
            """,
            (dataset_id,),
        )
        count, min_date, max_date = cursor.fetchone()
        cursor.execute(
            "SELECT time, open, high, low, close, volume, turnover FROM candles WHERE dataset_id=%s ORDER BY time",
            (dataset_id,),
        )
        checksum = canonical_checksum(cursor.fetchall())
        cursor.execute(
            """
            UPDATE market_datasets
            SET name=%s, checksum=%s, start_time=%s, end_time=%s, count=%s,
                source_file_name='akshare:stock_zh_index_daily_em', updated_at=%s
            WHERE id=%s
            """,
            (definition.name, checksum, min_date, max_date, count, now, dataset_id),
        )
    connection.commit()


def canonical_checksum(rows: list[tuple[Any, ...]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(("|".join("" if value is None else str(value) for value in row) + "\n").encode("utf-8"))
    return digest.hexdigest()


def optional_float(value: Any) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def load_dataset(connection, symbol: str):
    with connection.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute(
            """
            SELECT id, start_time, end_time
            FROM market_datasets
            WHERE asset_type='index' AND timeframe='1d' AND symbol=%s
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (symbol,),
        )
        return cursor.fetchone()


def next_date(value: str) -> str:
    parsed = datetime.strptime(value[:10], "%Y-%m-%d").date() + timedelta(days=1)
    return parsed.strftime("%Y%m%d")


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
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"),
        charset="utf8mb4",
        autocommit=False,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        raise
