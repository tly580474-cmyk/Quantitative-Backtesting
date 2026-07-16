from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pymysql

from index_constituents_update import (
    ConstituentBatch,
    ConstituentMember,
    deterministic_snapshot_id,
    load_env,
    load_instrument_keys,
    open_database,
    publish_batch,
    validate_batch,
)


@dataclass(frozen=True)
class StoredSnapshot:
    snapshot_id: str
    index_code: str
    index_name: str
    constituent_date: str
    members: tuple[ConstituentMember, ...]
    instrument_keys: dict[str, int]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Derive verified monthly index weights between two official weight anchors",
    )
    parser.add_argument("--index-code", required=True)
    parser.add_argument("--anchor-date", required=True)
    parser.add_argument("--validation-date", required=True)
    parser.add_argument("--targets", required=True, help="comma-separated calendar month-end dates")
    parser.add_argument("--max-validation-half-l1-pct", type=float, default=1.5)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    targets = [item.strip() for item in args.targets.split(",") if item.strip()]
    if not targets:
        raise RuntimeError("--targets must contain at least one date")
    connection = open_database()
    try:
        anchor = load_official_snapshot(connection, args.index_code, args.anchor_date)
        validation = load_official_snapshot(connection, args.index_code, args.validation_date)
        validation_error = validate_price_drift_method(
            connection,
            anchor,
            validation,
        )
        if validation_error > args.max_validation_half_l1_pct:
            raise RuntimeError(
                f"price-drift validation half-L1 {validation_error:.6f}% exceeds "
                f"{args.max_validation_half_l1_pct:.6f}%",
            )
        all_instrument_keys = load_instrument_keys(connection)
        items = []
        for requested_target in targets:
            target_date = resolve_trading_date(connection, requested_target)
            batch, max_staleness = derive_batch(
                connection,
                anchor,
                validation,
                target_date,
                validation_error,
            )
            validate_batch(batch)
            snapshot_id = (
                deterministic_snapshot_id(batch)
                if args.dry_run else publish_batch(connection, batch, all_instrument_keys)
            )
            items.append({
                "snapshotId": snapshot_id,
                "requestedTarget": requested_target,
                "targetDate": target_date,
                "members": len(batch.members),
                "weightSumPct": sum(item.weight_pct or 0 for item in batch.members),
                "anchorSnapshotId": anchor.snapshot_id,
                "validationSnapshotId": validation.snapshot_id,
                "validationHalfL1Pct": validation_error,
                "maxPriceStalenessDays": max_staleness,
            })
        print(json.dumps({"status": "ready", "items": items}, ensure_ascii=False))
        return 0
    finally:
        connection.close()


def load_official_snapshot(connection, index_code: str, constituent_date: str) -> StoredSnapshot:
    with connection.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute(
            """
            SELECT snapshot_id, index_code, index_name,
                   DATE_FORMAT(constituent_date, '%%Y-%%m-%%d') AS constituent_date
            FROM index_constituent_snapshots
            WHERE index_code=%s
              AND constituent_date=%s
              AND weight_date IS NOT NULL
              AND weight_method='official'
              AND status='published'
            ORDER BY source_captured_at DESC, fetched_at DESC
            LIMIT 1
            """,
            (index_code, constituent_date),
        )
        snapshot = cursor.fetchone()
        if not snapshot:
            raise RuntimeError(f"official weight snapshot not found: {index_code} {constituent_date}")
        cursor.execute(
            """
            SELECT constituent_code, constituent_name, constituent_name_en,
                   exchange, exchange_en, weight_pct, raw_code, instrument_key
            FROM index_constituent_members
            WHERE snapshot_id=%s
            ORDER BY constituent_code
            """,
            (snapshot["snapshot_id"],),
        )
        rows = cursor.fetchall()
    if not rows or any(row["weight_pct"] is None for row in rows):
        raise RuntimeError(f"official snapshot has missing weights: {snapshot['snapshot_id']}")
    instrument_keys = {
        str(row["constituent_code"]): int(row["instrument_key"])
        for row in rows
        if row["instrument_key"] is not None
    }
    if len(instrument_keys) != len(rows):
        raise RuntimeError(f"official snapshot contains unmapped instruments: {snapshot['snapshot_id']}")
    members = tuple(
        ConstituentMember(
            code=str(row["constituent_code"]),
            name=str(row["constituent_name"]),
            name_en=row["constituent_name_en"],
            exchange=row["exchange"],
            exchange_en=row["exchange_en"],
            weight_pct=float(row["weight_pct"]),
            raw_code=str(row["raw_code"]),
        )
        for row in rows
    )
    return StoredSnapshot(
        snapshot_id=str(snapshot["snapshot_id"]),
        index_code=str(snapshot["index_code"]),
        index_name=str(snapshot["index_name"]),
        constituent_date=str(snapshot["constituent_date"]),
        members=members,
        instrument_keys=instrument_keys,
    )


def resolve_trading_date(connection, requested_date: str) -> str:
    parsed = date.fromisoformat(requested_date)
    month_start = parsed.replace(day=1).isoformat()
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DATE_FORMAT(MAX(trade_date), '%%Y-%%m-%%d')
            FROM daily_bars_v2
            WHERE trade_date BETWEEN %s AND %s
            """,
            (month_start, requested_date),
        )
        resolved = cursor.fetchone()[0]
    if not resolved:
        raise RuntimeError(f"target month has no trading date: {requested_date}")
    return str(resolved)


def load_asof_prices(
    connection,
    instrument_keys: list[int],
    target_date: str,
) -> dict[int, tuple[float, str]]:
    placeholders = ",".join(["%s"] * len(instrument_keys))
    with connection.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute(
            f"""
            SELECT bar.instrument_key, bar.close,
                   DATE_FORMAT(bar.trade_date, '%%Y-%%m-%%d') AS trade_date
            FROM daily_bars_v2 AS bar
            INNER JOIN (
              SELECT instrument_key, MAX(trade_date) AS trade_date
              FROM daily_bars_v2
              WHERE instrument_key IN ({placeholders})
                AND trade_date <= %s
              GROUP BY instrument_key
            ) AS latest
              ON latest.instrument_key=bar.instrument_key
             AND latest.trade_date=bar.trade_date
            """,
            [*instrument_keys, target_date],
        )
        rows = cursor.fetchall()
    prices = {
        int(row["instrument_key"]): (float(row["close"]), str(row["trade_date"]))
        for row in rows
        if row["close"] is not None and float(row["close"]) > 0
    }
    if len(prices) != len(instrument_keys):
        missing = sorted(set(instrument_keys) - set(prices))
        raise RuntimeError(f"missing ASOF prices for {len(missing)} instruments at {target_date}")
    return prices


def derive_weight_values(
    anchor_weights: dict[str, float],
    anchor_instrument_keys: dict[str, int],
    anchor_prices: dict[int, tuple[float, str]],
    target_prices: dict[int, tuple[float, str]],
) -> dict[str, float]:
    raw = {}
    for code, weight in anchor_weights.items():
        instrument_key = anchor_instrument_keys[code]
        anchor_price = anchor_prices[instrument_key][0]
        target_price = target_prices[instrument_key][0]
        value = weight * target_price / anchor_price
        if not math.isfinite(value) or value < 0:
            raise RuntimeError(f"invalid derived weight value for {code}")
        raw[code] = value
    total = sum(raw.values())
    if total <= 0:
        raise RuntimeError("derived weights have a non-positive total")
    return {code: value * 100 / total for code, value in raw.items()}


def half_l1_pct(left: dict[str, float], right: dict[str, float]) -> float:
    return 0.5 * sum(
        abs(left.get(code, 0.0) - right.get(code, 0.0))
        for code in set(left) | set(right)
    )


def validate_price_drift_method(
    connection,
    anchor: StoredSnapshot,
    validation: StoredSnapshot,
) -> float:
    keys = list(anchor.instrument_keys.values())
    anchor_prices = load_asof_prices(connection, keys, anchor.constituent_date)
    validation_prices = load_asof_prices(connection, keys, validation.constituent_date)
    anchor_weights = {item.code: float(item.weight_pct or 0) for item in anchor.members}
    predicted = derive_weight_values(
        anchor_weights,
        anchor.instrument_keys,
        anchor_prices,
        validation_prices,
    )
    actual = {item.code: float(item.weight_pct or 0) for item in validation.members}
    return half_l1_pct(predicted, actual)


def derive_batch(
    connection,
    anchor: StoredSnapshot,
    validation: StoredSnapshot,
    target_date: str,
    validation_error: float,
) -> tuple[ConstituentBatch, int]:
    keys = list(anchor.instrument_keys.values())
    anchor_prices = load_asof_prices(connection, keys, anchor.constituent_date)
    target_prices = load_asof_prices(connection, keys, target_date)
    anchor_weights = {item.code: float(item.weight_pct or 0) for item in anchor.members}
    weights = derive_weight_values(
        anchor_weights,
        anchor.instrument_keys,
        anchor_prices,
        target_prices,
    )
    target = date.fromisoformat(target_date)
    max_staleness = max(
        (target - date.fromisoformat(price_date)).days
        for _, price_date in target_prices.values()
    )
    members = tuple(
        ConstituentMember(
            code=item.code,
            name=item.name,
            name_en=item.name_en,
            exchange=item.exchange,
            exchange_en=item.exchange_en,
            weight_pct=weights[item.code],
            raw_code=item.raw_code,
        )
        for item in anchor.members
    )
    return ConstituentBatch(
        index_code=anchor.index_code,
        index_name=anchor.index_name,
        constituent_date=target_date,
        weight_date=target_date,
        source_key=f"derived:price-drift:v1:{anchor.constituent_date}",
        members=members,
        weight_method="price_drift_verified",
        anchor_snapshot_id=anchor.snapshot_id,
        validation_snapshot_id=validation.snapshot_id,
        validation_half_l1_pct=validation_error,
    ), max_staleness


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        raise
