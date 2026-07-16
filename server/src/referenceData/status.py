from __future__ import annotations

import json
import os
from pathlib import Path

import pymysql

from dividend_update import TASK_KEY, load_env


def main() -> int:
    load_env(Path.cwd() / ".env")
    connection = pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"), port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"), charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) AS total FROM instruments WHERE type='stock'")
            total = int(cursor.fetchone()["total"])
            cursor.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM reference_data_backfill_items
                WHERE task_key=%s
                GROUP BY status
                """,
                (TASK_KEY,),
            )
            statuses = {row["status"]: int(row["count"]) for row in cursor.fetchall()}
            cursor.execute(
                """
                SELECT COUNT(*) AS events, COUNT(DISTINCT instrument_key) AS symbols,
                       MIN(report_period) AS minDate, MAX(report_period) AS maxDate
                FROM dividend_events
                """,
            )
            dividends = cursor.fetchone()
            cursor.execute(
                """
                SELECT COUNT(*) AS snapshots, COUNT(DISTINCT index_code) AS indices,
                       SUM(member_count) AS members, MIN(constituent_date) AS minDate,
                       MAX(constituent_date) AS maxDate
                FROM index_constituent_snapshots
                WHERE status='published'
                """,
            )
            constituents = cursor.fetchone()
            cursor.execute(
                """
                SELECT COUNT(*) AS rowsCount, COUNT(DISTINCT dataset.symbol) AS indices,
                       MIN(candle.time) AS minDate, MAX(candle.time) AS maxDate
                FROM candles AS candle
                INNER JOIN market_datasets AS dataset ON dataset.id=candle.dataset_id
                WHERE dataset.asset_type='index' AND dataset.timeframe='1d'
                """,
            )
            index_bars = cursor.fetchone()
        print(json.dumps({
            "status": "ready",
            "dividendBackfill": {
                "totalSymbols": total,
                "completedSymbols": statuses.get("completed", 0),
                "failedSymbols": statuses.get("failed", 0),
                "remainingSymbols": total - statuses.get("completed", 0),
                "coverage": round(statuses.get("completed", 0) / total, 6) if total else 0,
            },
            "dividendEvents": dividends,
            "indexBars": index_bars,
            "indexConstituents": constituents,
        }, ensure_ascii=False, default=str))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
