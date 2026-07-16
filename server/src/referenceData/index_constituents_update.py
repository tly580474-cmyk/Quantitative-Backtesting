from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import time
import urllib.parse
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
    source_url: str | None = None
    source_captured_at: datetime | None = None
    source_file_checksum: str | None = None
    weight_method: str = "official"
    anchor_snapshot_id: str | None = None
    validation_snapshot_id: str | None = None
    validation_half_l1_pct: float | None = None

    @property
    def checksum(self) -> str:
        digest = hashlib.sha256()
        for member in sorted(self.members, key=lambda item: item.code):
            weight = "" if member.weight_pct is None else format(member.weight_pct, ".12g")
            digest.update(f"{member.code}|{weight}\n".encode("utf-8"))
        return digest.hexdigest()


@dataclass(frozen=True)
class ArchiveSpec:
    path: Path
    index_code: str
    weighted: bool


@dataclass(frozen=True)
class WaybackCapture:
    timestamp: str
    original_url: str
    digest: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture versioned index constituent and weight snapshots")
    parser.add_argument("--symbols", default=",".join(DEFAULT_INDEX_CODES))
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--archive-root", help="import archived official constituent/weight XLS/XLSX")
    parser.add_argument("--archive-only", action="store_true")
    parser.add_argument("--wayback", action="store_true", help="import archived official files from Wayback")
    parser.add_argument("--wayback-only", action="store_true")
    parser.add_argument("--wayback-from", default="2005")
    parser.add_argument("--wayback-to", default=str(datetime.now().year))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    if args.archive_only and not args.archive_root:
        raise RuntimeError("--archive-only requires --archive-root")
    if args.wayback_only:
        args.wayback = True
    symbols = [item.strip() for item in args.symbols.split(",") if item.strip()]
    connection = open_database()
    results = []
    failures = []
    warnings = []
    try:
        instrument_keys = load_instrument_keys(connection)
        if args.archive_root:
            for spec in discover_archive_files(Path(args.archive_root), symbols):
                try:
                    source = (
                        "archive:csindex:closeweight"
                        if spec.weighted else "archive:csindex:constituents"
                    )
                    batch = normalize_csindex_batch(
                        read_csindex_frame(spec.path, spec.weighted),
                        spec.index_code,
                        source,
                        spec.weighted,
                    )
                    validate_batch(batch)
                    snapshot_id = (
                        deterministic_snapshot_id(batch)
                        if args.dry_run else publish_batch(connection, batch, instrument_keys)
                    )
                    results.append({
                        "symbol": spec.index_code,
                        "status": "archive-imported",
                        "file": str(spec.path),
                        "snapshotId": snapshot_id,
                        "constituentDate": batch.constituent_date,
                        "weightDate": batch.weight_date,
                        "members": len(batch.members),
                    })
                except Exception as error:
                    failures.append({"file": str(spec.path), "errors": [str(error)]})
        if args.wayback:
            wayback_batches, wayback_failures, wayback_warnings = fetch_wayback_batches(
                symbols,
                max(5.0, args.timeout),
                args.wayback_from,
                args.wayback_to,
            )
            failures.extend(wayback_failures)
            warnings.extend(wayback_warnings)
            for capture, batch in wayback_batches:
                try:
                    validate_batch(batch)
                    snapshot_id = (
                        deterministic_snapshot_id(batch)
                        if args.dry_run else publish_batch(connection, batch, instrument_keys)
                    )
                    results.append({
                        "symbol": batch.index_code,
                        "status": "wayback-imported",
                        "captureTimestamp": capture.timestamp,
                        "sourceUrl": capture.original_url,
                        "snapshotId": snapshot_id,
                        "constituentDate": batch.constituent_date,
                        "weightDate": batch.weight_date,
                        "members": len(batch.members),
                    })
                except Exception as error:
                    failures.append({
                        "symbol": batch.index_code,
                        "captureTimestamp": capture.timestamp,
                        "errors": [str(error)],
                    })
        if args.archive_only or args.wayback_only:
            payload = {
                "status": "ready" if not failures else "partial",
                "items": results,
                "failures": failures,
                "warnings": warnings,
            }
            print(json.dumps(payload, ensure_ascii=False))
            return 0 if not failures else 2
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
    payload = {
        "status": "ready" if not failures else "partial",
        "items": results,
        "failures": failures,
        "warnings": warnings,
    }
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
    return normalize_csindex_columns(frame, f"{symbol} {suffix}", weighted)


def wayback_source_urls(symbol: str) -> tuple[str, ...]:
    suffix = f"{symbol}closeweight.xls"
    return (
        f"http://www.csindex.com.cn/uploads/file/autofile/closeweight/{suffix}",
        (
            "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
            f"autofile/closeweight/{suffix}"
        ),
        (
            "https://csi-web-dev.oss-cn-shanghai-finance-1-pub.aliyuncs.com/"
            "static/html/csindex/public/uploads/file/autofile/closeweight/"
            f"{suffix}"
        ),
    )


def parse_wayback_cdx(payload: bytes) -> list[WaybackCapture]:
    decoded = json.loads(payload.decode("utf-8"))
    if not isinstance(decoded, list) or len(decoded) < 2:
        return []
    header = decoded[0]
    if not isinstance(header, list):
        raise RuntimeError("Wayback CDX response has no header")
    positions = {str(name): index for index, name in enumerate(header)}
    required = ("timestamp", "original", "digest")
    if any(name not in positions for name in required):
        raise RuntimeError("Wayback CDX response is missing required fields")
    captures = []
    for row in decoded[1:]:
        if not isinstance(row, list):
            continue
        captures.append(WaybackCapture(
            timestamp=str(row[positions["timestamp"]]),
            original_url=str(row[positions["original"]]),
            digest=str(row[positions["digest"]]),
        ))
    return captures


def parse_wayback_available(payload: bytes, requested_url: str) -> WaybackCapture | None:
    decoded = json.loads(payload.decode("utf-8"))
    closest = decoded.get("archived_snapshots", {}).get("closest")
    if not isinstance(closest, dict) or not closest.get("available"):
        return None
    timestamp = str(closest.get("timestamp", ""))
    if not re.fullmatch(r"\d{14}", timestamp):
        raise RuntimeError("Wayback availability response has an invalid timestamp")
    archive_url = str(closest.get("url", ""))
    match = re.match(r"^https?://web\.archive\.org/web/\d{14}(?:id_)?/(.+)$", archive_url)
    original_url = match.group(1) if match else requested_url
    return WaybackCapture(timestamp, original_url, f"available:{timestamp}")


def fetch_wayback_availability(
    source_url: str,
    timeout: float,
    from_year: str,
    to_year: str,
) -> list[WaybackCapture]:
    start = int(from_year)
    end = int(to_year)

    def fetch_year(year: int) -> WaybackCapture | None:
        params = urllib.parse.urlencode({"url": source_url, "timestamp": f"{year}0701"})
        payload = http_get_bytes(f"https://archive.org/wayback/available?{params}", timeout)
        return parse_wayback_available(payload, source_url)

    captures = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(fetch_year, year) for year in range(start, end + 1)]
        for future in as_completed(futures):
            try:
                capture = future.result()
            except Exception:
                continue
            if capture:
                captures.append(capture)
    return captures


def fetch_wayback_batches(
    symbols: list[str],
    timeout: float,
    from_year: str,
    to_year: str,
) -> tuple[
    list[tuple[WaybackCapture, ConstituentBatch]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    captures_by_digest: dict[tuple[str, str], WaybackCapture] = {}
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    def discover_source(
        symbol: str,
        source_url: str,
    ) -> tuple[str, list[WaybackCapture], dict[str, Any] | None]:
        warning = None
        try:
            params = [
                ("url", source_url),
                ("output", "json"),
                ("fl", "timestamp,original,digest,statuscode,mimetype,length"),
                ("filter", "statuscode:200"),
                ("collapse", "digest"),
                ("from", from_year),
                ("to", to_year),
                ("gzip", "false"),
            ]
            cdx_url = "http://web.archive.org/cdx/search/cdx?" + urllib.parse.urlencode(params)
            captures = parse_wayback_cdx(http_get_bytes(cdx_url, timeout))
        except Exception as error:
            warning = {
                "symbol": symbol,
                "sourceUrl": source_url,
                "stage": "wayback-cdx",
                "errors": [str(error)],
            }
            try:
                captures = fetch_wayback_availability(
                    source_url,
                    timeout,
                    from_year,
                    to_year,
                )
                warning["fallbackCaptures"] = len(captures)
            except Exception as fallback_error:
                captures = []
                warning["fallbackError"] = str(fallback_error)
        return symbol, captures, warning

    discovery_specs = [
        (symbol, source_url)
        for symbol in symbols
        for source_url in wayback_source_urls(symbol)
    ]
    with ThreadPoolExecutor(max_workers=min(6, len(discovery_specs))) as executor:
        futures = [
            executor.submit(discover_source, symbol, source_url)
            for symbol, source_url in discovery_specs
        ]
        for future in as_completed(futures):
            symbol, captures, warning = future.result()
            for capture in captures:
                captures_by_digest.setdefault((symbol, capture.digest), capture)
            if warning:
                warnings.append(warning)

    batches = []
    for (symbol, _), capture in sorted(
        captures_by_digest.items(),
        key=lambda item: (item[0][0], item[1].timestamp),
    ):
        try:
            archive_url = (
                f"http://web.archive.org/web/{capture.timestamp}id_/{capture.original_url}"
            )
            content = http_get_bytes(archive_url, timeout)
            if len(content) < 100:
                raise RuntimeError("archived file is empty")
            frame = normalize_csindex_columns(
                pd.read_excel(BytesIO(content)),
                f"{symbol} Wayback {capture.timestamp}",
                True,
            )
            captured_at = datetime.strptime(capture.timestamp, "%Y%m%d%H%M%S")
            batch = normalize_csindex_batch(
                frame,
                symbol,
                f"wayback:csindex:{capture.timestamp}",
                True,
                source_url=capture.original_url,
                source_captured_at=captured_at,
                source_file_checksum=hashlib.sha256(content).hexdigest(),
            )
            batches.append((capture, batch))
        except Exception as error:
            failures.append({
                "symbol": symbol,
                "captureTimestamp": capture.timestamp,
                "sourceUrl": capture.original_url,
                "stage": "wayback-download",
                "errors": [str(error)],
            })
        time.sleep(1)
    return batches, failures, warnings


def http_get_bytes(url: str, timeout: float) -> bytes:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    archive_host = urllib.parse.urlparse(url).netloc in {"web.archive.org", "archive.org"}
    if archive_host and curl:
        result = subprocess.run(
            [
                curl,
                "-fsSL",
                "--http1.1",
                "--compressed",
                "--retry", "4",
                "--retry-delay", "2",
                "--retry-all-errors",
                "-A", "Mozilla/5.0",
                url,
            ],
            capture_output=True,
            check=True,
            timeout=max(30.0, timeout * 5),
        )
        return result.stdout
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=timeout)
    response.raise_for_status()
    return response.content


def read_csindex_frame(path: Path, weighted: bool) -> pd.DataFrame:
    return normalize_csindex_columns(pd.read_excel(path), path.name, weighted)


def normalize_csindex_columns(
    frame: pd.DataFrame,
    source_label: str,
    weighted: bool,
) -> pd.DataFrame:
    modern_columns = [
        "日期", "指数代码", "指数名称", "指数英文名称", "成分券代码",
        "成分券名称", "成分券英文名称", "交易所", "交易所英文名称",
    ]
    if weighted:
        modern_columns.append("权重")
    historical_columns = [
        "日期", "指数代码", "指数名称", "指数英文名称", "成分券代码",
        "成分券名称", "成分券英文名称", "交易所",
    ]
    if weighted:
        historical_columns.append("权重")
    if len(frame.columns) == len(modern_columns):
        frame.columns = modern_columns
        return frame
    if len(frame.columns) == len(historical_columns):
        frame.columns = historical_columns
        frame["交易所英文名称"] = None
        return frame
    raise RuntimeError(
        f"{source_label} column count changed: {len(frame.columns)} "
        f"not in ({len(historical_columns)}, {len(modern_columns)})",
    )


def discover_archive_files(root: Path, symbols: list[str]) -> list[ArchiveSpec]:
    if not root.exists() or not root.is_dir():
        raise RuntimeError(f"archive root does not exist: {root}")
    allowed = set(symbols)
    specs = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in (".xls", ".xlsx"):
            continue
        match = re.search(r"(?<!\d)(\d{6})(?!\d)", path.stem)
        if not match or match.group(1) not in allowed:
            continue
        lower_name = path.stem.lower()
        weighted = "closeweight" in lower_name or "weight" in lower_name or "权重" in path.stem
        specs.append(ArchiveSpec(path, match.group(1), weighted))
    if not specs:
        raise RuntimeError(f"archive root contains no matching index XLS/XLSX files: {root}")
    return specs


def normalize_csindex_batch(
    frame: pd.DataFrame,
    requested_symbol: str,
    source_key: str,
    weighted: bool,
    source_url: str | None = None,
    source_captured_at: datetime | None = None,
    source_file_checksum: str | None = None,
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
        source_url=source_url,
        source_captured_at=source_captured_at,
        source_file_checksum=source_file_checksum,
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
               source_checksum, source_url, source_captured_at, source_file_checksum,
               weight_method, anchor_snapshot_id, validation_snapshot_id,
               validation_half_l1_pct, fetched_at, member_count, weight_sum_pct, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'published')
            ON DUPLICATE KEY UPDATE
              status='published'
            """,
            (
                snapshot_id, batch.index_code, batch.index_name, batch.constituent_date,
                batch.weight_date, batch.source_key, batch.checksum, batch.source_url,
                batch.source_captured_at, batch.source_file_checksum, batch.weight_method,
                batch.anchor_snapshot_id, batch.validation_snapshot_id,
                batch.validation_half_l1_pct, fetched_at, len(batch.members), total,
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
