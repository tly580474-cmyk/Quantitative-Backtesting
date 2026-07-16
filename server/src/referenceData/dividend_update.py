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
REFRESH_TASK_KEY = "dividend-refresh-akshare-em"


@dataclass(frozen=True)
class Instrument:
    instrument_key: int
    symbol: str
    status: str = "active"


@dataclass(frozen=True)
class WorkItem:
    instrument: Instrument
    task_key: str
    mode: str
    attempts: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Recoverable A-share dividend history updater")
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--retry-size", type=int, default=20)
    parser.add_argument("--refresh-size", type=int, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--retry-now", action="store_true", help="ignore retry backoff for this run")
    parser.add_argument("--symbol", help="update one symbol without changing the backfill queue")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    connection = open_database()
    results = []
    failures = []
    deduplicated = 0
    try:
        if not args.dry_run:
            deduplicated = deduplicate_business_events(connection)
        work_items = (
            [WorkItem(item, "", "probe") for item in load_symbol(connection, args.symbol)]
            if args.symbol else load_work_batch(
                connection,
                max(0, args.batch_size),
                max(0, args.retry_size),
                max(0, args.refresh_size),
                args.retry_now,
            )
        )
        if args.dry_run:
            print(json.dumps({
                "status": "planned",
                "items": [
                    {"symbol": item.instrument.symbol, "mode": item.mode}
                    for item in work_items
                ],
                "count": len(work_items),
            }, ensure_ascii=False))
            return 0
        with ThreadPoolExecutor(max_workers=min(max(1, args.workers), max(1, len(work_items)))) as executor:
            futures = {
                executor.submit(ak.stock_fhps_detail_em, symbol=item.instrument.symbol): item
                for item in work_items
            }
            for future in as_completed(futures):
                item = futures[future]
                try:
                    result, failure = process_fetched_item(connection, item, future.result(), None)
                except Exception as error:
                    result, failure = process_fetched_item(connection, item, None, error)
                if result is not None:
                    results.append(result)
                if failure is not None:
                    failures.append(failure)
    finally:
        connection.close()
    print(json.dumps({
        "status": "ready" if not failures else "partial",
        "completed": len(results),
        "failed": len(failures),
        "deduplicated": deduplicated,
        "itemSamples": results[:20],
        "failures": failures[:20],
    }, ensure_ascii=False))
    return 0 if results or not failures else 2


def process_fetched_item(
    connection,
    item: WorkItem,
    frame: pd.DataFrame | None,
    fetch_error: Exception | None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    instrument = item.instrument
    try:
        if fetch_error is not None:
            raise fetch_error
        assert frame is not None
        events = normalize_dividend_events(frame, instrument)
        publish_events(connection, instrument, events)
        status = completion_status(events)
        if item.task_key:
            mark_backfill(connection, item.task_key, instrument.instrument_key, status, None)
        return {
            "symbol": instrument.symbol,
            "mode": item.mode,
            "events": len(events),
            "coverageStatus": status,
        }, None
    except Exception as error:
        message = str(error)[:1000]
        status = classify_failure(instrument, item.attempts + 1, message)
        if item.task_key:
            mark_backfill(connection, item.task_key, instrument.instrument_key, status, message)
        if status == "no_data":
            return {
                "symbol": instrument.symbol,
                "mode": item.mode,
                "events": 0,
                "coverageStatus": status,
                "sourceMessage": message,
            }, None
        return None, {
            "symbol": instrument.symbol,
            "mode": item.mode,
            "status": status,
            "error": message,
        }


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
            existing = find_business_event(cursor, event)
            if existing:
                cursor.execute(
                    """
                    UPDATE dividend_events
                    SET disclosure_date=COALESCE(%s, disclosure_date),
                        announcement_date=COALESCE(%s, announcement_date),
                        record_date=COALESCE(%s, record_date),
                        ex_date=COALESCE(%s, ex_date),
                        latest_announcement_date=COALESCE(%s, latest_announcement_date),
                        dividend_yield_raw=COALESCE(%s, dividend_yield_raw),
                        plan_status=COALESCE(%s, plan_status),
                        raw_plan=COALESCE(%s, raw_plan), fetched_at=%s
                    WHERE event_id=%s
                    """,
                    (
                        event["disclosure_date"], event["announcement_date"],
                        event["record_date"], event["ex_date"],
                        event["latest_announcement_date"], event["dividend_yield_raw"],
                        event["plan_status"], event["raw_plan"], now, existing,
                    ),
                )
                continue
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


def find_business_event(cursor, event: dict[str, Any]) -> str | None:
    cursor.execute(
        """
        SELECT event_id
        FROM dividend_events
        WHERE instrument_key=%s AND report_period=%s
          AND ex_date<=>%s
          AND cash_dividend_per_share<=>%s
          AND bonus_share_per_share<=>%s
          AND transfer_share_per_share<=>%s
        ORDER BY fetched_at DESC
        LIMIT 1
        """,
        (
            event["instrument_key"], event["report_period"], event["ex_date"],
            event["cash_dividend_per_share"], event["bonus_share_per_share"],
            event["transfer_share_per_share"],
        ),
    )
    row = cursor.fetchone()
    return None if not row else str(row[0])


def deduplicate_business_events(connection) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT instrument_key, report_period, ex_date, cash_dividend_per_share,
                   bonus_share_per_share, transfer_share_per_share
            FROM dividend_events
            GROUP BY instrument_key, report_period, ex_date, cash_dividend_per_share,
                     bonus_share_per_share, transfer_share_per_share
            HAVING COUNT(*)>1
            """
        )
        groups = cursor.fetchall()
        removed = 0
        for group in groups:
            cursor.execute(
                """
                SELECT event_id, disclosure_date, announcement_date, record_date,
                       latest_announcement_date, dividend_yield_raw, plan_status, raw_plan
                FROM dividend_events
                WHERE instrument_key=%s AND report_period=%s AND ex_date<=>%s
                  AND cash_dividend_per_share<=>%s
                  AND bonus_share_per_share<=>%s
                  AND transfer_share_per_share<=>%s
                ORDER BY (source_key='akshare:stock_fhps_detail_em') DESC,
                         (raw_plan IS NOT NULL) DESC, fetched_at DESC
                """,
                group,
            )
            rows = cursor.fetchall()
            keeper = rows[0]
            merged = [
                next((row[index] for row in rows if row[index] is not None), None)
                for index in range(1, 8)
            ]
            cursor.execute(
                """
                UPDATE dividend_events
                SET disclosure_date=%s, announcement_date=%s, record_date=%s,
                    latest_announcement_date=%s, dividend_yield_raw=%s,
                    plan_status=%s, raw_plan=%s
                WHERE event_id=%s
                """,
                (*merged, keeper[0]),
            )
            duplicate_ids = [row[0] for row in rows[1:]]
            placeholders = ",".join(["%s"] * len(duplicate_ids))
            cursor.execute(
                f"DELETE FROM dividend_events WHERE event_id IN ({placeholders})",
                duplicate_ids,
            )
            removed += len(duplicate_ids)
    connection.commit()
    return removed


def load_work_batch(
    connection,
    backfill_size: int,
    retry_size: int,
    refresh_size: int,
    retry_now: bool = False,
) -> list[WorkItem]:
    return [
        *load_new_backfill_batch(connection, backfill_size),
        *load_retry_batch(connection, retry_size, retry_now),
        *load_refresh_batch(connection, refresh_size),
    ]


def load_new_backfill_batch(connection, batch_size: int) -> list[WorkItem]:
    if batch_size <= 0:
        return []
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT instrument.instrument_key, instrument.symbol, instrument.status
            FROM instruments AS instrument
            LEFT JOIN reference_data_backfill_items AS item
              ON item.task_key=%s AND item.instrument_key=instrument.instrument_key
            WHERE instrument.type='stock' AND item.instrument_key IS NULL
            ORDER BY instrument.instrument_key
            LIMIT %s
            """,
            (TASK_KEY, batch_size),
        )
        return [
            WorkItem(Instrument(int(key), str(symbol).zfill(6), str(status)), TASK_KEY, "backfill")
            for key, symbol, status in cursor.fetchall()
        ]


def load_retry_batch(connection, retry_size: int, retry_now: bool = False) -> list[WorkItem]:
    if retry_size <= 0:
        return []
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT instrument.instrument_key, instrument.symbol, instrument.status, item.attempts
            FROM reference_data_backfill_items AS item
            INNER JOIN instruments AS instrument
              ON instrument.instrument_key=item.instrument_key
            WHERE item.task_key=%s AND item.status='failed'
              AND (
                %s
                OR TIMESTAMPDIFF(MINUTE, item.updated_at, UTC_TIMESTAMP()) >=
                   LEAST(1440, POW(2, GREATEST(item.attempts-1, 0)) * 30)
              )
            ORDER BY item.updated_at, instrument.instrument_key
            LIMIT %s
            """,
            (TASK_KEY, 1 if retry_now else 0, retry_size),
        )
        return [
            WorkItem(
                Instrument(int(key), str(symbol).zfill(6), str(status)),
                TASK_KEY,
                "retry",
                int(attempts),
            )
            for key, symbol, status, attempts in cursor.fetchall()
        ]


def load_refresh_batch(connection, refresh_size: int) -> list[WorkItem]:
    if refresh_size <= 0:
        return []
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT instrument.instrument_key, instrument.symbol, instrument.status,
                   COALESCE(refresh.attempts, 0)
            FROM reference_data_backfill_items AS history
            INNER JOIN instruments AS instrument
              ON instrument.instrument_key=history.instrument_key
            LEFT JOIN reference_data_backfill_items AS refresh
              ON refresh.task_key=%s AND refresh.instrument_key=instrument.instrument_key
            WHERE history.task_key=%s AND history.status IN ('completed', 'no_data')
              AND (
                refresh.instrument_key IS NULL
                OR (refresh.status='completed' AND refresh.updated_at<UTC_TIMESTAMP()-INTERVAL 30 DAY)
                OR (refresh.status='failed' AND TIMESTAMPDIFF(MINUTE, refresh.updated_at, UTC_TIMESTAMP()) >=
                    LEAST(1440, POW(2, GREATEST(refresh.attempts-1, 0)) * 30))
              )
            ORDER BY
              CASE WHEN refresh.status='failed' THEN 0 WHEN refresh.instrument_key IS NULL THEN 1 ELSE 2 END,
              refresh.updated_at, instrument.instrument_key
            LIMIT %s
            """,
            (REFRESH_TASK_KEY, TASK_KEY, refresh_size),
        )
        return [
            WorkItem(
                Instrument(int(key), str(symbol).zfill(6), str(status)),
                REFRESH_TASK_KEY,
                "refresh",
                int(attempts),
            )
            for key, symbol, status, attempts in cursor.fetchall()
        ]


def load_symbol(connection, symbol: str | None) -> list[Instrument]:
    if not symbol:
        return []
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT instrument_key, symbol, status FROM instruments WHERE symbol=%s AND type='stock' LIMIT 1",
            (symbol.zfill(6),),
        )
        row = cursor.fetchone()
        if not row:
            raise RuntimeError(f"unknown stock symbol: {symbol}")
        return [Instrument(int(row[0]), str(row[1]).zfill(6), str(row[2]))]


def classify_failure(instrument: Instrument, attempts: int, message: str) -> str:
    source_has_no_detail = "NoneType" in message and "subscriptable" in message
    if source_has_no_detail and attempts >= 2:
        return "no_data"
    return "failed"


def completion_status(events: list[dict[str, Any]]) -> str:
    return "completed" if events else "no_data"


def mark_backfill(
    connection,
    task_key: str,
    instrument_key: int,
    status: str,
    error: str | None,
) -> None:
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
            (task_key, instrument_key, status, error),
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
