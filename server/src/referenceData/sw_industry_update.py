from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import pandas as pd
import requests
import urllib3

from dividend_update import load_env, open_database


TAXONOMY_KEY = "SW2021"
TAXONOMY_START = pd.Timestamp("2021-07-30 00:00:00")
SOURCE_BASE = "https://www.swsresearch.com"
CLASS_CODE_URL = f"{SOURCE_BASE}/swindex/pdf/SwClass2021/SwClassCode_2021.xls"
MEMBERSHIP_URL = f"{SOURCE_BASE}/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls"
API_BASE = f"{SOURCE_BASE}/institute-sw/api/index_publish"
DEFINITION_SOURCE = "swsresearch:SwClassCode_2021.xls"
MEMBERSHIP_SOURCE = "swsresearch:StockClassifyUse_stock.xls"
BAR_SOURCE = "swsresearch:index_publish:trend"
OLE_MAGIC = bytes.fromhex("d0cf11e0a1b11ae1")

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


@dataclass(frozen=True)
class Instrument:
    instrument_key: int
    symbol: str
    status: str
    delist_date: str | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import SW2021 industry taxonomy, memberships, and bars")
    parser.add_argument(
        "--local-zip",
        default=r"C:\Users\qjmzc\Downloads\申万分类.zip",
        help="optional local level-1 membership event archive used for validation",
    )
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--skip-bars", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env(Path.cwd() / ".env")
    args = parse_args()
    timeout = max(5.0, args.timeout)
    fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)

    class_bytes = fetch_guarded_xls(CLASS_CODE_URL, timeout)
    membership_bytes = fetch_guarded_xls(MEMBERSHIP_URL, timeout)
    current_level1 = fetch_json(
        f"{API_BASE}/current/",
        {"page": 1, "page_size": 50, "indextype": "一级行业"},
        timeout,
    )["data"]["results"]
    definitions = normalize_definitions(
        pd.read_excel(io.BytesIO(class_bytes), dtype=str).fillna(""),
        current_level1,
    )
    definition_version = hashlib.sha256(class_bytes).hexdigest()
    membership_version = hashlib.sha256(membership_bytes).hexdigest()

    connection = open_database()
    try:
        instruments = load_instruments(connection)
        memberships = normalize_memberships(
            pd.read_excel(
                io.BytesIO(membership_bytes),
                dtype={"股票代码": str, "行业代码": str},
            ),
            definitions,
            instruments,
        )
        validate_membership_coverage(memberships, instruments)
        local_validation = validate_local_zip(Path(args.local_zip), memberships, definitions)
        bars = [] if args.skip_bars else fetch_all_bars(
            definitions,
            max(1, args.workers),
            timeout,
        )
        if not args.dry_run:
            publish_definitions(connection, definitions, definition_version, fetched_at)
            publish_memberships(connection, memberships, membership_version, fetched_at)
            if bars:
                publish_bars(connection, bars, fetched_at)
    finally:
        connection.close()

    payload = {
        "status": "planned" if args.dry_run else "ready",
        "taxonomy": {
            "key": TAXONOMY_KEY,
            "definitions": len(definitions),
            "levels": level_counts(definitions),
            "sourceVersion": definition_version,
        },
        "memberships": {
            "events": len(memberships),
            "symbols": len({item["symbol"] for item in memberships}),
            "mappedEvents": sum(item["instrument_key"] is not None for item in memberships),
            "minEffectiveFrom": min(item["effective_from"] for item in memberships),
            "maxEffectiveFrom": max(item["effective_from"] for item in memberships),
            "sourceVersion": membership_version,
        },
        "bars": {
            "rows": len(bars),
            "indices": len({item["index_code"] for item in bars}),
            "minDate": min((item["trade_date"] for item in bars), default=None),
            "maxDate": max((item["trade_date"] for item in bars), default=None),
        },
        "localZipValidation": local_validation,
    }
    print(json.dumps(payload, ensure_ascii=False, default=str))
    return 0


def fetch_guarded_xls(url: str, timeout: float, attempts: int = 3) -> bytes:
    content = fetch_bytes(url, timeout, attempts)
    if len(content) < 1024 or not content.startswith(OLE_MAGIC):
        raise RuntimeError(f"invalid official SW xls payload: {url}")
    return content


def fetch_bytes(url: str, timeout: float, attempts: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(
                url,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=timeout,
                verify=False,
            )
            response.raise_for_status()
            return response.content
        except Exception as error:
            last_error = error
            if attempt < attempts:
                time.sleep(attempt)
    assert last_error is not None
    raise last_error


def fetch_json(url: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = requests.get(
                url,
                params=params,
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=timeout,
                verify=False,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or "data" not in payload:
                raise RuntimeError(f"unexpected official SW response: {url}")
            return payload
        except Exception as error:
            last_error = error
            if attempt < 3:
                time.sleep(attempt)
    assert last_error is not None
    raise last_error


def normalize_definitions(
    frame: pd.DataFrame,
    current_level1: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    required = ("行业代码", "一级行业名称", "二级行业名称", "三级行业名称")
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise RuntimeError("SW taxonomy missing columns: " + ", ".join(missing))
    index_by_name = {
        str(item["swindexname"]).strip(): str(item["swindexcode"]).strip()
        for item in current_level1
    }
    definitions = []
    codes = set()
    for _, row in frame.iterrows():
        code = str(row["行业代码"]).strip().zfill(6)
        if code in codes:
            raise RuntimeError(f"duplicate SW industry code: {code}")
        codes.add(code)
        if code.endswith("0000"):
            level = 1
            name = str(row["一级行业名称"]).strip()
            parent = None
            index_code = index_by_name.get(name)
        elif code.endswith("00"):
            level = 2
            name = str(row["二级行业名称"]).strip()
            parent = f"{code[:2]}0000"
            index_code = None
        else:
            level = 3
            name = str(row["三级行业名称"]).strip()
            parent = f"{code[:4]}00"
            index_code = None
        if not name:
            raise RuntimeError(f"SW industry {code} has no name")
        definitions.append({
            "industry_code": code,
            "industry_name": name,
            "industry_level": level,
            "parent_code": parent,
            "index_code": index_code,
        })
    for item in definitions:
        parent = item["parent_code"]
        if parent and parent not in codes:
            raise RuntimeError(f"SW industry {item['industry_code']} missing parent {parent}")
    level1 = [item for item in definitions if item["industry_level"] == 1]
    if len(level1) != 31 or any(not item["index_code"] for item in level1):
        missing_names = [
            item["industry_name"] for item in level1 if not item["index_code"]
        ]
        raise RuntimeError(f"SW level-1 index mapping incomplete: {missing_names}")
    if len({item["index_code"] for item in level1}) != 31:
        raise RuntimeError("SW level-1 index codes are not unique")
    return definitions


def normalize_memberships(
    frame: pd.DataFrame,
    definitions: list[dict[str, Any]],
    instruments: dict[str, Instrument],
) -> list[dict[str, Any]]:
    required = ("股票代码", "计入日期", "行业代码", "更新日期")
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise RuntimeError("SW membership history missing columns: " + ", ".join(missing))
    valid_codes = {item["industry_code"] for item in definitions}
    work = frame.copy()
    work["symbol"] = work["股票代码"].astype(str).str.strip().str.zfill(6)
    work["industry_code"] = work["行业代码"].astype(str).str.strip().str.zfill(6)
    work["effective_from"] = pd.to_datetime(work["计入日期"], errors="coerce")
    work["source_updated_at"] = pd.to_datetime(work["更新日期"], errors="coerce")
    if work["effective_from"].isna().any():
        raise RuntimeError("SW membership history contains invalid effective dates")
    work.sort_values(["symbol", "effective_from", "source_updated_at"], inplace=True)
    events = []
    for symbol, rows in work.groupby("symbol", sort=True):
        rows = rows.drop_duplicates("effective_from", keep="last")
        before = rows[rows["effective_from"] <= TAXONOMY_START]
        candidates: list[tuple[pd.Timestamp, pd.Series]] = []
        if not before.empty:
            seed = before.iloc[-1]
            if seed["industry_code"] in valid_codes:
                candidates.append((TAXONOMY_START, seed))
        after = rows[
            (rows["effective_from"] > TAXONOMY_START)
            & rows["industry_code"].isin(valid_codes)
        ]
        candidates.extend((row["effective_from"], row) for _, row in after.iterrows())
        previous_code = None
        normalized = []
        for effective_from, row in candidates:
            code = str(row["industry_code"])
            if code == previous_code:
                continue
            previous_code = code
            normalized.append((pd.Timestamp(effective_from), row))
        instrument = instruments.get(symbol)
        for index, (effective_from, row) in enumerate(normalized):
            effective_to = (
                normalized[index + 1][0] - pd.Timedelta(milliseconds=1)
                if index + 1 < len(normalized) else None
            )
            if effective_to is None and instrument and instrument.delist_date:
                delist_end = pd.Timestamp(instrument.delist_date) + pd.Timedelta(days=1) - pd.Timedelta(milliseconds=1)
                if delist_end >= effective_from:
                    effective_to = delist_end
            level3 = str(row["industry_code"])
            events.append({
                "symbol": symbol,
                "instrument_key": instrument.instrument_key if instrument else None,
                "level1_code": f"{level3[:2]}0000",
                "level2_code": f"{level3[:4]}00",
                "level3_code": level3,
                "effective_from": effective_from.to_pydatetime(),
                "effective_to": None if effective_to is None else pd.Timestamp(effective_to).to_pydatetime(),
                "source_updated_at": optional_datetime(row["source_updated_at"]),
            })
    return events


def load_instruments(connection) -> dict[str, Instrument]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT instrument_key, symbol, status, delist_date FROM instruments WHERE type='stock'"
        )
        return {
            str(symbol).zfill(6): Instrument(
                int(key), str(symbol).zfill(6), str(status), None if not delist else str(delist)[:10]
            )
            for key, symbol, status, delist in cursor.fetchall()
        }


def validate_membership_coverage(
    memberships: list[dict[str, Any]],
    instruments: dict[str, Instrument],
) -> None:
    covered = {item["symbol"] for item in memberships if item["effective_to"] is None}
    active = {symbol for symbol, item in instruments.items() if item.status == "active"}
    missing = sorted(active - covered)
    if missing:
        raise RuntimeError(
            f"SW2021 current membership missing {len(missing)} active instruments: {missing[:20]}"
        )


def validate_local_zip(
    path: Path,
    memberships: list[dict[str, Any]],
    definitions: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not path.exists():
        return None
    level1_by_name = {
        item["industry_name"]: item["industry_code"]
        for item in definitions if item["industry_level"] == 1
    }
    frames = []
    with ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            frame = pd.read_excel(io.BytesIO(archive.read(info)), dtype=str).fillna("")
            required = {"行业名称", "股票代码", "股票名称", "计入日期"}
            if not required.issubset(frame.columns):
                raise RuntimeError(f"local SW zip schema changed: {info.filename}")
            frame["source_file"] = info.filename
            frames.append(frame)
    combined = pd.concat(frames, ignore_index=True)
    combined["symbol"] = combined["股票代码"].astype(str).str.zfill(6)
    combined["effective_from"] = pd.to_datetime(combined["计入日期"], errors="coerce")
    combined["level1_code"] = combined["行业名称"].map(level1_by_name)
    if combined["effective_from"].isna().any() or combined["level1_code"].isna().any():
        raise RuntimeError("local SW zip contains invalid dates or industry names")
    online_keys = {
        (item["symbol"], pd.Timestamp(item["effective_from"]), item["level1_code"])
        for item in memberships
    }
    local_keys = {
        (row.symbol, row.effective_from, row.level1_code)
        for row in combined.itertuples()
    }
    return {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "files": len(frames),
        "rows": len(combined),
        "matchedOnlineEvents": len(local_keys & online_keys),
        "localOnlyEvents": len(local_keys - online_keys),
        "onlineOnlyEvents": len(online_keys - local_keys),
    }


def fetch_all_bars(
    definitions: list[dict[str, Any]],
    workers: int,
    timeout: float,
) -> list[dict[str, Any]]:
    level1 = [item for item in definitions if item["industry_level"] == 1]
    results = []
    errors = []
    with ThreadPoolExecutor(max_workers=min(workers, len(level1))) as executor:
        futures = {
            executor.submit(fetch_industry_bars, item, timeout): item
            for item in level1
        }
        for future in as_completed(futures):
            item = futures[future]
            try:
                results.extend(future.result())
            except Exception as error:
                errors.append({"indexCode": item["index_code"], "error": str(error)})
    if errors:
        raise RuntimeError(f"SW industry bar fetch failed: {errors}")
    return results


def fetch_industry_bars(
    definition: dict[str, Any],
    timeout: float,
) -> list[dict[str, Any]]:
    index_code = str(definition["index_code"])
    payload = fetch_json(
        f"{API_BASE}/trend/",
        {"swindexcode": index_code, "period": "DAY"},
        timeout,
    )
    frame = pd.DataFrame(payload["data"])
    if frame.empty:
        raise RuntimeError(f"{index_code} returned no history")
    required = (
        "bargaindate", "openindex", "maxindex", "minindex", "closeindex",
        "bargainamount", "bargainsum",
    )
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise RuntimeError(f"{index_code} history missing columns: {missing}")
    frame["trade_date"] = pd.to_datetime(frame["bargaindate"], errors="coerce")
    for column in required[1:]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame.sort_values("trade_date", inplace=True)
    frame.drop_duplicates("trade_date", keep="last", inplace=True)
    prices = frame[["openindex", "maxindex", "minindex", "closeindex"]]
    if frame["trade_date"].isna().any() or prices.isna().any().any():
        raise RuntimeError(f"{index_code} history contains invalid values")
    if (prices <= 0).any().any():
        raise RuntimeError(f"{index_code} history contains non-positive prices")
    if (frame["maxindex"] < frame[["openindex", "closeindex"]].max(axis=1)).any():
        raise RuntimeError(f"{index_code} history contains invalid highs")
    if (frame["minindex"] > frame[["openindex", "closeindex"]].min(axis=1)).any():
        raise RuntimeError(f"{index_code} history contains invalid lows")
    previous = frame["closeindex"].shift(1)
    frame["change"] = frame["closeindex"] - previous
    frame["change_percent"] = frame["change"] / previous * 100
    source_version = f"{frame.iloc[-1]['trade_date'].strftime('%Y-%m-%d')}:{len(frame)}"
    return [
        {
            "index_code": index_code,
            "industry_code": definition["industry_code"],
            "industry_name": definition["industry_name"],
            "trade_date": row.trade_date.strftime("%Y-%m-%d"),
            "open": float(row.openindex),
            "high": float(row.maxindex),
            "low": float(row.minindex),
            "close": float(row.closeindex),
            "change": optional_float(row.change),
            "change_percent": optional_float(row.change_percent),
            "volume_raw": optional_float(row.bargainamount),
            "amount_raw": optional_float(row.bargainsum),
            "source_version": source_version,
        }
        for row in frame.itertuples(index=False)
    ]


def publish_definitions(
    connection,
    definitions: list[dict[str, Any]],
    source_version: str,
    fetched_at: datetime,
) -> None:
    rows = [
        (
            TAXONOMY_KEY, item["industry_code"], item["industry_name"],
            item["industry_level"], item["parent_code"], item["index_code"],
            DEFINITION_SOURCE, source_version, fetched_at,
        )
        for item in definitions
    ]
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM sw_industry_definitions WHERE taxonomy_key=%s", (TAXONOMY_KEY,))
        cursor.executemany(
            """
            INSERT INTO sw_industry_definitions
              (taxonomy_key, industry_code, industry_name, industry_level, parent_code,
               index_code, source_key, source_version, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
    connection.commit()


def publish_memberships(
    connection,
    memberships: list[dict[str, Any]],
    source_version: str,
    fetched_at: datetime,
) -> None:
    rows = [
        (
            TAXONOMY_KEY, item["symbol"], item["instrument_key"], item["level1_code"],
            item["level2_code"], item["level3_code"], item["effective_from"],
            item["effective_to"], MEMBERSHIP_SOURCE, source_version,
            item["source_updated_at"], fetched_at,
        )
        for item in memberships
    ]
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM sw_industry_memberships WHERE taxonomy_key=%s", (TAXONOMY_KEY,))
        cursor.executemany(
            """
            INSERT INTO sw_industry_memberships
              (taxonomy_key, symbol, instrument_key, level1_code, level2_code, level3_code,
               effective_from, effective_to, source_key, source_version,
               source_updated_at, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            rows,
        )
    connection.commit()


def publish_bars(connection, bars: list[dict[str, Any]], fetched_at: datetime) -> None:
    rows = [
        (
            TAXONOMY_KEY, item["index_code"], item["industry_code"],
            item["industry_name"], item["trade_date"], item["open"], item["high"],
            item["low"], item["close"], item["change"], item["change_percent"],
            item["volume_raw"], item["amount_raw"], BAR_SOURCE,
            item["source_version"], fetched_at,
        )
        for item in bars
    ]
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO sw_industry_daily_bars
              (taxonomy_key, index_code, industry_code, industry_name, trade_date,
               open, high, low, close, `change`, change_percent, volume_raw, amount_raw,
               source_key, source_version, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              industry_code=VALUES(industry_code), industry_name=VALUES(industry_name),
              open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close),
              `change`=VALUES(`change`), change_percent=VALUES(change_percent),
              volume_raw=VALUES(volume_raw), amount_raw=VALUES(amount_raw),
              source_key=VALUES(source_key), source_version=VALUES(source_version),
              fetched_at=VALUES(fetched_at)
            """,
            rows,
        )
    connection.commit()


def level_counts(definitions: list[dict[str, Any]]) -> dict[str, int]:
    return {
        f"L{level}": sum(item["industry_level"] == level for item in definitions)
        for level in (1, 2, 3)
    }


def optional_float(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def optional_datetime(value: Any) -> datetime | None:
    if value is None or pd.isna(value):
        return None
    return pd.Timestamp(value).to_pydatetime()


if __name__ == "__main__":
    raise SystemExit(main())
