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
from io import BytesIO
from pathlib import Path
from typing import Any

import pandas as pd
import pymysql
import requests


DEFAULT_INDEX_CODES = ("000300", "000905", "000852", "932000", "000688", "000680")


@dataclass(frozen=True)
class ConstituentMember:
    code: str
    name: str
    name_en: str | None
    exchange: str | None
    exchange_en: str | None
    weight_pct: float | None
    raw_code: str


@dataclass(frozen=True)
class ConstituentBatch:
    index_code: str
    index_name: str
    constituent_date: str
    weight_date: str | None
    source_key: str
    members: tuple[ConstituentMember, ...]

    @property
    def checksum(self) -> str:
        digest = hashlib.sha256()
        for member in sorted(self.members, key=lambda item: item.code):
            weight = "" if member.weight_pct is None else format(member.weight_pct, ".12g")
            digest.update(f"{member.code}|{weight}\n".encode("utf-8"))
        return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture versioned index constituent and weight snapshots")
    parser.add_argument("--symbols", default=",".join(DEFAULT_INDEX_CODES))
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    symbols = [item.strip() for item in args.symbols.split(",") if item.strip()]
    connection = open_database()
    results = []
    failures = []
    try:
        instrument_keys = load_instrument_keys(connection)
        fetched = fetch_all_sources(symbols, max(1, args.workers), max(5.0, args.timeout))
        for symbol in symbols:
            batches = []
            errors = []
            for weighted in (False, True):
                try:
                    source = (
                        "akshare:index_stock_cons_weight_csindex"
                        if weighted else "akshare:index_stock_cons_csindex"
                    )
                    raw = fetched[(symbol, weighted)]
                    if isinstance(raw, Exception):
                        raise raw
                    batch = normalize_csindex_batch(raw, symbol, source, weighted)
                    validate_batch(batch)
                    batches.append(batch)
                except Exception as error:
                    errors.append(str(error))
            if not batches:
                cached = load_latest_snapshot(connection, symbol)
                if cached:
                    results.append({
                        "symbol": symbol,
                        "status": "cached-fallback",
                        "constituentDate": str(cached["constituent_date"]),
                        "members": int(cached["member_count"]),
                        "warnings": errors,
                    })
                else:
                    failures.append({"symbol": symbol, "errors": errors})
                continue
            published = []
            for batch in batches:
                if args.dry_run:
                    snapshot_id = deterministic_snapshot_id(batch)
                else:
                    snapshot_id = publish_batch(connection, batch, instrument_keys)
                published.append({
                    "snapshotId": snapshot_id,
                    "source": batch.source_key,
                    "constituentDate": batch.constituent_date,
                    "weightDate": batch.weight_date,
                    "members": len(batch.members),
                    "weightSumPct": weight_sum(batch),
                })
            results.append({"symbol": symbol, "snapshots": published, "warnings": errors})
    finally:
        connection.close()
    payload = {"status": "ready" if not failures else "partial", "items": results, "failures": failures}
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if not failures else 2


def fetch_all_sources(
    symbols: list[str],
    workers: int,
    timeout: float,
) -> dict[tuple[str, bool], pd.DataFrame | Exception]:
    results: dict[tuple[str, bool], pd.DataFrame | Exception] = {}
    specs = [(symbol, weighted) for symbol in symbols for weighted in (False, True)]
    with ThreadPoolExecutor(max_workers=min(workers, len(specs))) as executor:
        futures = {
            executor.submit(fetch_csindex_file, symbol, weighted, timeout): (symbol, weighted)
            for symbol, weighted in specs
        }
        for future in as_completed(futures):
            spec = futures[future]
            try:
                results[spec] = future.result()
            except Exception as error:
                results[spec] = error
    return results


def fetch_csindex_file(symbol: str, weighted: bool, timeout: float) -> pd.DataFrame:
    folder = "closeweight" if weighted else "cons"
    suffix = "closeweight" if weighted else "cons"
    url = (
        "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
        f"autofile/{folder}/{symbol}{suffix}.xls"
    )
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    if len(response.content) < 100:
        raise RuntimeError(f"{symbol} {suffix} returned an empty file")
    frame = pd.read_excel(BytesIO(response.content))
    columns = [
        "日期", "指数代码", "指数名称", "指数英文名称", "成分券代码",
        "成分券名称", "成分券英文名称", "交易所", "交易所英文名称",
    ]
    if weighted:
        columns.append("权重")
    if len(frame.columns) != len(columns):
        raise RuntimeError(
            f"{symbol} {suffix} column count changed: {len(frame.columns)} != {len(columns)}",
        )
    frame.columns = columns
    return frame


def normalize_csindex_batch(
    frame: pd.DataFrame,
    requested_symbol: str,
    source_key: str,
    weighted: bool,
) -> ConstituentBatch:
    if frame.empty:
        raise RuntimeError(f"{requested_symbol} returned no constituent rows")
    required = ("日期", "指数代码", "指数名称", "成分券代码", "成分券名称")
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise RuntimeError(f"{requested_symbol} missing columns: {', '.join(missing)}")
    work = frame.copy()
    parsed_dates = parse_source_dates(work["日期"])
    date_values = parsed_dates.dropna()
    if date_values.empty:
        raise RuntimeError(f"{requested_symbol} has no valid source date")
    source_date = date_values.max().strftime("%Y-%m-%d")
    work = work[parsed_dates.dt.strftime("%Y-%m-%d") == source_date]
    index_code = normalize_code(work.iloc[0]["指数代码"] or requested_symbol)
    index_name = str(work.iloc[0]["指数名称"]).strip()
    members = []
    for _, row in work.iterrows():
        raw_code = str(row["成分券代码"]).strip()
        code = normalize_code(raw_code)
        weight = optional_float(row.get("权重")) if weighted else None
        members.append(ConstituentMember(
            code=code,
            name=str(row["成分券名称"]).strip(),
            name_en=optional_text(row.get("成分券英文名称")),
            exchange=optional_text(row.get("交易所")),
            exchange_en=optional_text(row.get("交易所英文名称")),
            weight_pct=weight,
            raw_code=raw_code,
        ))
    return ConstituentBatch(
        index_code=index_code or requested_symbol,
        index_name=index_name,
        constituent_date=source_date,
        weight_date=source_date if weighted else None,
        source_key=source_key,
        members=tuple(members),
    )


def validate_batch(batch: ConstituentBatch) -> None:
    if not batch.members:
        raise RuntimeError(f"{batch.index_code} has no members")
    codes = [item.code for item in batch.members]
    if len(codes) != len(set(codes)):
        raise RuntimeError(f"{batch.index_code} contains duplicate members")
    for member in batch.members:
        if not member.code:
            raise RuntimeError(f"{batch.index_code} contains an empty member code")
        if member.weight_pct is not None and (
            not math.isfinite(member.weight_pct) or member.weight_pct < 0
        ):
            raise RuntimeError(f"{batch.index_code} contains an invalid weight")
    total = weight_sum(batch)
    if total is not None and not 90 <= total <= 110:
        raise RuntimeError(f"{batch.index_code} weight sum {total:.6f}% is outside 90%-110%")


def publish_batch(connection, batch: ConstituentBatch, instrument_keys: dict[str, int]) -> str:
    snapshot_id = deterministic_snapshot_id(batch)
    fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    total = weight_sum(batch)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO index_constituent_snapshots
              (snapshot_id, index_code, index_name, constituent_date, weight_date, source_key,
               source_checksum, fetched_at, member_count, weight_sum_pct, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'published')
            ON DUPLICATE KEY UPDATE
              status='published'
            """,
            (
                snapshot_id, batch.index_code, batch.index_name, batch.constituent_date,
                batch.weight_date, batch.source_key, batch.checksum, fetched_at,
                len(batch.members), total,
            ),
        )
        cursor.execute("DELETE FROM index_constituent_members WHERE snapshot_id=%s", (snapshot_id,))
        cursor.executemany(
            """
            INSERT INTO index_constituent_members
              (snapshot_id, constituent_code, instrument_key, constituent_name,
               constituent_name_en, exchange, exchange_en, weight_pct, raw_code)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    snapshot_id, member.code, instrument_keys.get(member.code), member.name,
                    member.name_en, member.exchange, member.exchange_en, member.weight_pct,
                    member.raw_code,
                )
                for member in batch.members
            ],
        )
    connection.commit()
    return snapshot_id


def deterministic_snapshot_id(batch: ConstituentBatch) -> str:
    key = f"{batch.index_code}|{batch.constituent_date}|{batch.source_key}|{batch.checksum}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, key))


def weight_sum(batch: ConstituentBatch) -> float | None:
    weights = [member.weight_pct for member in batch.members if member.weight_pct is not None]
    return sum(weights) if weights else None


def normalize_code(value: Any) -> str:
    text = str(value).strip().split(".")[0]
    return text.zfill(6) if text.isdigit() and len(text) <= 6 else text


def parse_source_dates(values: pd.Series) -> pd.Series:
    text = values.astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    compact = text.str.fullmatch(r"\d{8}")
    parsed = pd.to_datetime(text.where(~compact), errors="coerce")
    parsed.loc[compact] = pd.to_datetime(text.loc[compact], format="%Y%m%d", errors="coerce")
    return parsed


def optional_float(value: Any) -> float | None:
    if value is None or pd.isna(value) or str(value).strip() in ("", "-"):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def optional_text(value: Any) -> str | None:
    if value is None or pd.isna(value):
        return None
    text = str(value).strip()
    return text or None


def load_instrument_keys(connection) -> dict[str, int]:
    with connection.cursor() as cursor:
        cursor.execute("SELECT symbol, instrument_key FROM instruments WHERE instrument_key IS NOT NULL")
        return {str(symbol).zfill(6): int(key) for symbol, key in cursor.fetchall()}


def load_latest_snapshot(connection, symbol: str):
    with connection.cursor(pymysql.cursors.DictCursor) as cursor:
        cursor.execute(
            """
            SELECT constituent_date, member_count
            FROM index_constituent_snapshots
            WHERE index_code=%s AND status='published'
            ORDER BY constituent_date DESC, fetched_at DESC
            LIMIT 1
            """,
            (symbol,),
        )
        return cursor.fetchone()


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
