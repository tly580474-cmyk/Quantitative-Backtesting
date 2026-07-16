from __future__ import annotations

import argparse
import hashlib
import json
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import akshare as ak
import pandas as pd

from dividend_update import (
    Instrument,
    deduplicate_business_events,
    load_env,
    open_database,
    optional_date,
    optional_float,
    optional_text,
    per_ten_to_per_share,
)


SOURCE_KEY = "akshare:stock_fhps_em"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh current A-share dividend plans by report period")
    parser.add_argument("--periods", help="comma-separated report periods such as 20251231,20260630")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def default_periods(today: date) -> list[str]:
    periods = [f"{today.year - 1}1231"]
    if today.month >= 4:
        periods.append(f"{today.year}0331")
    if today.month >= 7:
        periods.append(f"{today.year}0630")
    if today.month >= 10:
        periods.append(f"{today.year}0930")
    return periods


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    periods = (
        [item.strip() for item in args.periods.split(",") if item.strip()]
        if args.periods else default_periods(date.today())
    )
    for period in periods:
        datetime.strptime(period, "%Y%m%d")

    connection = open_database()
    results = []
    failures = []
    try:
        if not args.dry_run:
            deduplicate_business_events(connection)
        instruments = load_instrument_map(connection)
        for period in periods:
            try:
                frame = fetch_period_with_retry(period)
                events, unmapped = normalize_current_events(frame, instruments, period)
                published = {"inserted": 0, "updated": 0}
                if not args.dry_run:
                    published = publish_current_events(connection, events)
                results.append({
                    "period": period,
                    "sourceRows": len(frame),
                    "events": len(events),
                    "unmapped": unmapped[:20],
                    **published,
                })
            except Exception as error:
                failures.append({"period": period, "error": str(error)[:1000]})
    finally:
        connection.close()

    print(json.dumps({
        "status": "ready" if not failures else "partial",
        "periods": results,
        "failures": failures,
    }, ensure_ascii=False))
    return 0 if results else 2


def fetch_period_with_retry(period: str, attempts: int = 3) -> pd.DataFrame:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            frame = ak.stock_fhps_em(date=period)
            if frame is None:
                raise RuntimeError("current dividend source returned None")
            return frame
        except Exception as error:
            last_error = error
            if attempt < attempts:
                time.sleep(attempt)
    assert last_error is not None
    raise last_error


def load_instrument_map(connection) -> dict[str, Instrument]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT instrument_key, symbol, status FROM instruments WHERE type='stock'")
        return {
            str(symbol).zfill(6): Instrument(int(key), str(symbol).zfill(6), str(status))
            for key, symbol, status in cursor.fetchall()
        }


def normalize_current_events(
    frame: pd.DataFrame,
    instruments: dict[str, Instrument],
    report_period: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    if frame.empty:
        return [], []
    required = ("代码", "现金分红-现金分红比例", "送转股份-转股比例")
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise RuntimeError("current dividend source missing columns: " + ", ".join(missing))
    normalized_period = datetime.strptime(report_period, "%Y%m%d").strftime("%Y-%m-%d")
    events = []
    unmapped = []
    for _, row in frame.iterrows():
        symbol = str(row.get("代码", "")).strip().zfill(6)
        instrument = instruments.get(symbol)
        if not instrument:
            unmapped.append(symbol)
            continue
        cash = per_ten_to_per_share(row.get("现金分红-现金分红比例"))
        bonus = per_ten_to_per_share(
            row.get("送转股份-送股比例", row.get("送转股份-送转比例"))
        )
        transfer = per_ten_to_per_share(row.get("送转股份-转股比例"))
        ex_date = optional_date(row.get("除权除息日"))
        fingerprint_payload = "|".join([
            str(instrument.instrument_key), normalized_period, ex_date or "",
            "" if cash is None else format(cash, ".12g"),
            "" if bonus is None else format(bonus, ".12g"),
            "" if transfer is None else format(transfer, ".12g"),
        ])
        fingerprint = hashlib.sha256(fingerprint_payload.encode("utf-8")).hexdigest()
        events.append({
            "event_id": str(uuid.uuid5(uuid.NAMESPACE_URL, fingerprint)),
            "instrument_key": instrument.instrument_key,
            "report_period": normalized_period,
            "announcement_date": optional_date(row.get("预案公告日")),
            "record_date": optional_date(row.get("股权登记日")),
            "ex_date": ex_date,
            "latest_announcement_date": optional_date(row.get("最新公告日期")),
            "cash_dividend_per_share": cash,
            "bonus_share_per_share": bonus,
            "transfer_share_per_share": transfer,
            "dividend_yield_raw": optional_float(row.get("现金分红-股息率")),
            "plan_status": optional_text(row.get("方案进度")),
            "source_fingerprint": fingerprint,
        })
    return events, unmapped


def publish_current_events(connection, events: list[dict[str, Any]]) -> dict[str, int]:
    inserted = 0
    updated = 0
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with connection.cursor() as cursor:
        for event in events:
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
            existing = cursor.fetchone()
            if existing:
                cursor.execute(
                    """
                    UPDATE dividend_events
                    SET announcement_date=COALESCE(%s, announcement_date),
                        record_date=COALESCE(%s, record_date),
                        ex_date=COALESCE(%s, ex_date),
                        latest_announcement_date=COALESCE(%s, latest_announcement_date),
                        dividend_yield_raw=COALESCE(%s, dividend_yield_raw),
                        plan_status=COALESCE(%s, plan_status), fetched_at=%s
                    WHERE event_id=%s
                    """,
                    (
                        event["announcement_date"], event["record_date"], event["ex_date"],
                        event["latest_announcement_date"], event["dividend_yield_raw"],
                        event["plan_status"], now, existing[0],
                    ),
                )
                updated += 1
                continue
            cursor.execute(
                """
                INSERT INTO dividend_events
                  (event_id, instrument_key, report_period, announcement_date, record_date,
                   ex_date, latest_announcement_date, cash_dividend_per_share,
                   bonus_share_per_share, transfer_share_per_share, dividend_yield_raw,
                   plan_status, source_key, source_fingerprint, fetched_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    event["event_id"], event["instrument_key"], event["report_period"],
                    event["announcement_date"], event["record_date"], event["ex_date"],
                    event["latest_announcement_date"], event["cash_dividend_per_share"],
                    event["bonus_share_per_share"], event["transfer_share_per_share"],
                    event["dividend_yield_raw"], event["plan_status"], SOURCE_KEY,
                    event["source_fingerprint"], now,
                ),
            )
            inserted += 1
    connection.commit()
    return {"inserted": inserted, "updated": updated}


if __name__ == "__main__":
    raise SystemExit(main())
