from __future__ import annotations

import json
import os
from pathlib import Path

import pymysql

from dividend_update import REFRESH_TASK_KEY, TASK_KEY, load_env


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
            attempted = sum(statuses.values())
            cursor.execute(
                """
                SELECT status, COUNT(*) AS count, MAX(updated_at) AS latestUpdate
                FROM reference_data_backfill_items
                WHERE task_key=%s
                GROUP BY status
                """,
                (REFRESH_TASK_KEY,),
            )
            refresh_statuses = {
                row["status"]: {
                    "count": int(row["count"]),
                    "latestUpdate": row["latestUpdate"],
                }
                for row in cursor.fetchall()
            }
            cursor.execute(
                """
                SELECT COUNT(*) AS events, COUNT(DISTINCT instrument_key) AS symbols,
                       MIN(report_period) AS minDate, MAX(report_period) AS maxDate,
                       MAX(fetched_at) AS latestFetchedAt
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
            cursor.execute(
                """
                SELECT COUNT(*) AS rowsCount
                FROM candles AS candle
                INNER JOIN market_datasets AS dataset ON dataset.id=candle.dataset_id
                WHERE dataset.asset_type='index' AND dataset.timeframe='1d'
                  AND (candle.`change` IS NULL OR candle.change_percent IS NULL)
                  AND EXISTS (
                    SELECT 1 FROM candles AS previous
                    WHERE previous.dataset_id=candle.dataset_id AND previous.time<candle.time
                  )
                """,
            )
            missing_index_returns = int(cursor.fetchone()["rowsCount"])
        print(json.dumps({
            "status": "ready",
            "dividendBackfill": {
                "totalSymbols": total,
                "completedSymbols": statuses.get("completed", 0),
                "neverAttemptedSymbols": max(0, total - attempted),
                "retryPendingSymbols": statuses.get("failed", 0),
                "terminalNoDataSymbols": statuses.get("no_data", 0),
                "remainingSymbols": max(0, total - statuses.get("completed", 0) - statuses.get("no_data", 0)),
                "coverage": round(statuses.get("completed", 0) / total, 6) if total else 0,
            },
            "dividendRefresh": refresh_statuses,
            "dividendEvents": dividends,
            "indexBars": {**index_bars, "missingDerivedReturns": missing_index_returns},
            "indexConstituents": constituents,
        }, ensure_ascii=False, default=str))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
