from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, time as clock_time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


SHANGHAI = ZoneInfo("Asia/Shanghai")
PUBLISH_AFTER = clock_time(15, 10)
EXPECTED_COLUMNS = [
    "code", "trade_time", "close", "open", "high", "low", "vol", "amount",
    "date", "pre_close", "change", "pct_chg", "__index_level_0__",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Incrementally fetch and publish A-share 1-minute Parquet files",
    )
    parser.add_argument(
        "--output-root",
        default=os.getenv("MINUTE_DATA_ROOT", "../../所有股票的历史数据/1m_price_parquet"),
    )
    parser.add_argument("--start-date", help="YYYY-MM-DD; defaults to the day after manifest.lastDate")
    parser.add_argument("--end-date", help="YYYY-MM-DD; defaults to the latest finalized Shanghai date")
    parser.add_argument("--workers", type=int, default=int(os.getenv("MINUTE_UPDATE_WORKERS", "4")))
    parser.add_argument(
        "--requests-per-minute",
        type=int,
        default=int(os.getenv("MINUTE_UPDATE_REQUESTS_PER_MINUTE", "180")),
    )
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


@dataclass(frozen=True)
class UpdatePlan:
    manifest_last_date: str
    start_date: str
    end_date: str
    existing_dates: frozenset[str]


class RateLimiter:
    def __init__(self, requests_per_minute: int) -> None:
        self.interval = 60.0 / max(1, requests_per_minute)
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            delay = max(0.0, self.next_at - now)
            self.next_at = max(now, self.next_at) + self.interval
        if delay:
            time.sleep(delay)


class TushareSource:
    def __init__(self, token: str, requests_per_minute: int, retries: int) -> None:
        try:
            import tushare as ts
        except ImportError as error:
            raise RuntimeError(
                "缺少 tushare；请执行 python -m pip install -r src/minuteData/requirements.txt",
            ) from error
        self.pro = ts.pro_api(token)
        self.limiter = RateLimiter(requests_per_minute)
        self.retries = max(0, retries)

    def call(self, api: str, **kwargs: Any):
        method = getattr(self.pro, api)
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            self.limiter.wait()
            try:
                return method(**kwargs)
            except Exception as error:  # provider errors are not typed by the SDK
                last_error = error
                if attempt >= self.retries:
                    break
                time.sleep(min(30.0, (2 ** attempt) + random.random()))
        assert last_error is not None
        raise last_error

    def trading_dates(self, start_date: str, end_date: str) -> list[str]:
        frame = self.call(
            "trade_cal",
            exchange="SSE",
            start_date=start_date.replace("-", ""),
            end_date=end_date.replace("-", ""),
            is_open="1",
            fields="cal_date,is_open",
        )
        return sorted(format_compact_date(value) for value in frame["cal_date"].tolist())

    def stock_universe(self):
        import pandas as pd

        frames = []
        for status in ("L", "D", "P"):
            frames.append(self.call(
                "stock_basic",
                exchange="",
                list_status=status,
                fields="ts_code,list_date,delist_date",
            ))
        frame = pd.concat(frames, ignore_index=True)
        frame = frame.drop_duplicates(subset=["ts_code"], keep="first")
        return frame

    def daily(self, trade_date: str):
        return self.call("daily", trade_date=trade_date.replace("-", ""))

    def minutes(self, symbol: str, trade_date: str):
        return self.call(
            "stk_mins",
            ts_code=symbol,
            freq="1min",
            start_date=f"{trade_date} 09:00:00",
            end_date=f"{trade_date} 16:00:00",
        )


def main() -> int:
    load_env_file(Path.cwd() / ".env")
    args = parse_args()
    root = Path(args.output_root).resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    plan = build_plan(manifest, args.start_date, args.end_date)

    token = os.getenv("TUSHARE_TOKEN", "").strip()
    summary = {
        "root": str(root),
        "manifestLastDate": plan.manifest_last_date,
        "startDate": plan.start_date,
        "endDate": plan.end_date,
        "dryRun": bool(args.dry_run),
        "tokenConfigured": bool(token),
        "workers": max(1, args.workers),
        "requestsPerMinute": max(1, args.requests_per_minute),
    }
    if args.dry_run:
        print(json.dumps({"status": "planned", **summary}, ensure_ascii=False))
        return 0
    if plan.start_date > plan.end_date:
        print(json.dumps({"status": "up-to-date", **summary, "tradingDates": 0}, ensure_ascii=False))
        return 0
    if not token:
        raise RuntimeError("未配置 TUSHARE_TOKEN；历史分钟 stk_mins 还需要单独开通分钟权限")

    source = TushareSource(token, args.requests_per_minute, args.retries)
    trading_dates = source.trading_dates(plan.start_date, plan.end_date)
    pending_dates = [
        item for item in trading_dates
        if args.overwrite or item not in plan.existing_dates
    ]
    if not pending_dates:
        print(json.dumps({"status": "up-to-date", **summary, "tradingDates": 0}, ensure_ascii=False))
        return 0

    universe = source.stock_universe()
    published: list[dict[str, Any]] = []
    for trade_date in pending_dates:
        started = time.monotonic()
        result = update_one_day(
            root,
            manifest,
            source,
            universe,
            trade_date,
            max(1, args.workers),
            args.overwrite,
        )
        published.append(result)
        print(json.dumps({
            "status": "published",
            **result,
            "elapsedSeconds": round(time.monotonic() - started, 1),
        }, ensure_ascii=False), flush=True)

    print(json.dumps({
        "status": "ready",
        **summary,
        "publishedDates": len(published),
        "lastPublishedDate": published[-1]["date"],
    }, ensure_ascii=False))
    return 0


def build_plan(
    manifest: dict[str, Any],
    requested_start: str | None,
    requested_end: str | None,
    now: datetime | None = None,
) -> UpdatePlan:
    files = manifest.get("files") or []
    if not files:
        raise ValueError("manifest 没有任何分钟文件，不能执行增量更新")
    existing_dates = frozenset(str(item["date"]) for item in files)
    last_date = max(existing_dates)
    start_date = validate_date(requested_start) if requested_start else iso_add_days(last_date, 1)
    end_date = validate_date(requested_end) if requested_end else latest_finalized_date(now)
    if requested_start and start_date > end_date:
        raise ValueError("start-date 不能晚于 end-date")
    return UpdatePlan(last_date, start_date, end_date, existing_dates)


def latest_finalized_date(now: datetime | None = None) -> str:
    current = now.astimezone(SHANGHAI) if now else datetime.now(SHANGHAI)
    target = current.date() if current.time() >= PUBLISH_AFTER else current.date() - timedelta(days=1)
    return target.isoformat()


def update_one_day(
    root: Path,
    manifest: dict[str, Any],
    source: TushareSource,
    universe_frame,
    trade_date: str,
    workers: int,
    overwrite: bool,
) -> dict[str, Any]:
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    target = root / f"year={trade_date[:4]}" / f"{trade_date.replace('-', '')}.parquet"
    if target.exists() and not overwrite:
        return {"date": trade_date, "file": str(target), "skipped": True}

    universe = universe_for_date(universe_frame, trade_date)
    daily = normalize_daily(source.daily(trade_date))
    daily_by_code = daily.set_index("ts_code").to_dict("index") if not daily.empty else {}
    previous_close = load_previous_close(root, manifest, trade_date)
    symbols = sorted(set(universe) | set(daily_by_code))
    if not symbols:
        raise RuntimeError(f"{trade_date} 股票池为空，拒绝发布")

    frames: list[Any] = []
    errors: list[str] = []

    def fetch(symbol: str):
        raw = source.minutes(symbol, trade_date)
        daily_row = daily_by_code.get(symbol)
        fallback = daily_pre_close(daily_row, previous_close.get(symbol))
        if raw.empty and daily_row and float(daily_row.get("vol") or 0) > 0:
            raise RuntimeError("日线有成交但分钟接口返回空")
        return normalize_symbol_minutes(symbol, trade_date, raw, fallback)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fetch, symbol): symbol for symbol in symbols}
        for completed, future in enumerate(as_completed(futures), start=1):
            symbol = futures[future]
            try:
                frames.append(future.result())
            except Exception as error:
                errors.append(f"{symbol}: {error}")
            if completed % 250 == 0 or completed == len(symbols):
                print(json.dumps({
                    "status": "fetching",
                    "date": trade_date,
                    "completedSymbols": completed,
                    "totalSymbols": len(symbols),
                    "errors": len(errors),
                }, ensure_ascii=False), flush=True)
    if errors:
        raise RuntimeError(
            f"{trade_date} 有 {len(errors)} 只股票拉取或标准化失败，拒绝发布："
            + "; ".join(errors[:10]),
        )

    result = pd.concat(frames, ignore_index=True).sort_values(["code", "trade_time"])
    result["__index_level_0__"] = result.groupby("code", sort=False).cumcount()
    validate_day_frame(result, daily, trade_date, len(symbols))
    result = result[EXPECTED_COLUMNS]
    for column in ("close", "open", "high", "low", "vol", "amount", "pre_close", "change", "pct_chg"):
        result[column] = result[column].astype("float32")
    result["__index_level_0__"] = result["__index_level_0__"].astype("int64")

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".parquet.partial")
    temporary.unlink(missing_ok=True)
    table = pa.Table.from_pandas(result, preserve_index=False)
    pq.write_table(table, temporary, compression="snappy")
    verify_written_parquet(temporary, trade_date, len(symbols))
    os.replace(temporary, target)
    entry = {
        "date": trade_date,
        "relativePath": f"year={trade_date[:4]}/{target.name}",
        "bytes": target.stat().st_size,
        "crc32": file_crc32(target),
        "source": "tushare:stk_mins",
    }
    publish_manifest(root, manifest, entry)
    return {
        "date": trade_date,
        "file": str(target),
        "symbols": len(symbols),
        "rows": len(result),
        "bytes": entry["bytes"],
        "skipped": False,
    }


def universe_for_date(frame, trade_date: str) -> list[str]:
    compact = trade_date.replace("-", "")
    normalized = frame.fillna("")
    mask = (normalized["list_date"] <= compact) & (
        (normalized["delist_date"] == "") | (normalized["delist_date"] >= compact)
    )
    return normalized.loc[mask, "ts_code"].astype(str).tolist()


def normalize_daily(frame):
    import pandas as pd

    if frame is None or frame.empty:
        return pd.DataFrame(columns=[
            "ts_code", "open", "high", "low", "close", "pre_close", "vol", "amount",
        ])
    required = {"ts_code", "open", "high", "low", "close", "pre_close", "vol", "amount"}
    missing = required - set(frame.columns)
    if missing:
        raise RuntimeError(f"日线接口缺少字段：{sorted(missing)}")
    return frame.copy()


def daily_pre_close(daily_row: dict[str, Any] | None, previous_close: float | None) -> float | None:
    if daily_row:
        value = finite_number(daily_row.get("pre_close"))
        if value is not None:
            return value
    return finite_number(previous_close)


def normalize_symbol_minutes(symbol: str, trade_date: str, raw, pre_close: float | None):
    import pandas as pd

    grid = pd.DataFrame({"trade_time": expected_trade_times(trade_date)})
    if raw is None or raw.empty:
        if pre_close is None:
            raise RuntimeError("停牌或空数据且找不到昨收价")
        source = pd.DataFrame(columns=["trade_time", "open", "high", "low", "close", "vol", "amount"])
    else:
        source = raw.rename(columns={"time": "trade_time", "ts_code": "code"}).copy()
        required = {"trade_time", "open", "high", "low", "close", "vol", "amount"}
        missing = required - set(source.columns)
        if missing:
            raise RuntimeError(f"分钟接口缺少字段：{sorted(missing)}")
        source["trade_time"] = source["trade_time"].astype(str).str.slice(0, 19)
        source = source[source["trade_time"].str.startswith(trade_date)]
        source = source.drop_duplicates(subset=["trade_time"], keep="last")
        source = source[list(required)]
    merged = grid.merge(source, how="left", on="trade_time")
    actual_close = merged["close"].copy()
    merged["close"] = merged["close"].ffill().fillna(pre_close)
    if merged["close"].isna().any():
        raise RuntimeError("价格时间轴无法补齐")
    missing_bar = actual_close.isna()
    for column in ("open", "high", "low"):
        merged.loc[missing_bar, column] = merged.loc[missing_bar, "close"]
    merged["vol"] = merged["vol"].fillna(0)
    merged["amount"] = merged["amount"].fillna(0)
    merged.insert(0, "code", symbol)
    merged["date"] = trade_date.replace("-", "")
    merged["pre_close"] = merged["close"].shift(1)
    merged.loc[0, "pre_close"] = pre_close
    merged["change"] = merged["close"] - merged["pre_close"]
    merged["pct_chg"] = merged["change"] / merged["pre_close"] * 100
    merged.loc[merged["pre_close"] == 0, "pct_chg"] = math.nan
    return merged


def expected_trade_times(trade_date: str) -> list[str]:
    morning = minute_range(clock_time(9, 30), clock_time(11, 30))
    afternoon = minute_range(clock_time(13, 1), clock_time(15, 0))
    return [f"{trade_date} {value}:00" for value in morning + afternoon]


def minute_range(start: clock_time, end: clock_time) -> list[str]:
    cursor = datetime.combine(date(2000, 1, 1), start)
    finish = datetime.combine(date(2000, 1, 1), end)
    values: list[str] = []
    while cursor <= finish:
        values.append(cursor.strftime("%H:%M"))
        cursor += timedelta(minutes=1)
    return values


def validate_day_frame(frame, daily, trade_date: str, symbol_count: int) -> None:
    expected_rows = symbol_count * 241
    if len(frame) != expected_rows:
        raise RuntimeError(f"{trade_date} 行数异常：{len(frame)}，期望 {expected_rows}")
    if frame[["code", "trade_time"]].duplicated().any():
        raise RuntimeError(f"{trade_date} 存在重复的代码/分钟")
    index_stats = frame.groupby("code")["__index_level_0__"].agg(["min", "max", "nunique"])
    if ((index_stats["min"] != 0) | (index_stats["max"] != 240) | (index_stats["nunique"] != 241)).any():
        raise RuntimeError(f"{trade_date} 源索引不符合逐股 0-240 约定")
    numeric = frame[["open", "high", "low", "close", "vol", "amount"]]
    if numeric.isna().any().any():
        raise RuntimeError(f"{trade_date} 存在空 OHLC/成交字段")
    invalid = (
        (frame["low"] > frame[["open", "close"]].min(axis=1))
        | (frame["high"] < frame[["open", "close"]].max(axis=1))
        | (frame["high"] < frame["low"])
        | (frame["vol"] < 0)
        | (frame["amount"] < 0)
    )
    if invalid.any():
        raise RuntimeError(f"{trade_date} 有 {int(invalid.sum())} 行违反 OHLC/成交约束")
    reconcile_daily(frame, daily, trade_date)


def reconcile_daily(frame, daily, trade_date: str) -> None:
    if daily.empty:
        raise RuntimeError(f"{trade_date} 日线对账源为空")
    traded = daily[daily["vol"].fillna(0) > 0].copy()
    if traded.empty:
        raise RuntimeError(f"{trade_date} 日线没有任何成交证券")
    aggregated = frame.groupby("code", sort=False).agg(
        open=("open", "first"), high=("high", "max"), low=("low", "min"),
        close=("close", "last"), vol=("vol", "sum"), amount=("amount", "sum"),
    )
    failures: list[str] = []
    for row in traded.itertuples(index=False):
        symbol = str(row.ts_code)
        if symbol not in aggregated.index:
            failures.append(f"{symbol}: 分钟缺失")
            continue
        actual = aggregated.loc[symbol]
        price_ok = all(
            abs(float(actual[field]) - float(getattr(row, field))) <= 0.011
            for field in ("open", "high", "low", "close")
        )
        expected_vol = float(row.vol) * 100
        expected_amount = float(row.amount) * 1000
        vol_ok = abs(float(actual["vol"]) - expected_vol) <= max(1.0, expected_vol * 1e-6)
        amount_ok = abs(float(actual["amount"]) - expected_amount) <= max(100.0, expected_amount * 0.001)
        if not (price_ok and vol_ok and amount_ok):
            failures.append(f"{symbol}: OHLC/量额不一致")
    if failures:
        raise RuntimeError(
            f"{trade_date} 日线对账失败 {len(failures)} 只：" + "; ".join(failures[:10]),
        )


def load_previous_close(root: Path, manifest: dict[str, Any], trade_date: str) -> dict[str, float]:
    import pyarrow.parquet as pq

    candidates = [item for item in manifest["files"] if str(item["date"]) < trade_date]
    if not candidates:
        return {}
    latest = max(candidates, key=lambda item: str(item["date"]))
    path = root / str(latest["relativePath"])
    frame = pq.read_table(path, columns=["code", "trade_time", "close"]).to_pandas()
    frame = frame.sort_values("trade_time").drop_duplicates("code", keep="last")
    return dict(zip(frame["code"].astype(str), frame["close"].astype(float)))


def verify_written_parquet(path: Path, trade_date: str, symbol_count: int) -> None:
    import pyarrow.parquet as pq

    parquet = pq.ParquetFile(path)
    if parquet.metadata.num_rows != symbol_count * 241:
        raise RuntimeError(f"{trade_date} 写盘后行数校验失败")
    if parquet.schema_arrow.names != EXPECTED_COLUMNS:
        raise RuntimeError(f"{trade_date} 写盘后字段顺序不一致：{parquet.schema_arrow.names}")


def publish_manifest(root: Path, manifest: dict[str, Any], entry: dict[str, Any]) -> None:
    files = [item for item in manifest["files"] if item["date"] != entry["date"]]
    files.append(entry)
    files.sort(key=lambda item: item["date"])
    manifest["files"] = files
    manifest["startYear"] = int(files[0]["date"][:4])
    manifest["endYear"] = int(files[-1]["date"][:4])
    manifest["preparedAt"] = datetime.now(ZoneInfo("UTC")).isoformat()
    rebuild_year_summaries(root, manifest)
    temporary = root / "manifest.json.partial"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, root / "manifest.json")


def rebuild_year_summaries(root: Path, manifest: dict[str, Any]) -> None:
    prior = {int(item["year"]): item for item in manifest.get("years", [])}
    years: list[dict[str, Any]] = []
    for year in range(int(manifest["startYear"]), int(manifest["endYear"]) + 1):
        items = [item for item in manifest["files"] if item["date"].startswith(f"{year}-")]
        if not items:
            continue
        old = prior.get(year, {})
        years.append({
            "year": year,
            "sourceZip": str(old.get("sourceZip", "incremental")),
            "sourceBytes": int(old.get("sourceBytes", 0)),
            "sourceModifiedAt": str(old.get("sourceModifiedAt", datetime.now(ZoneInfo("UTC")).isoformat())),
            "fileCount": len(items),
            "firstDate": items[0]["date"],
            "lastDate": items[-1]["date"],
            "parquetBytes": sum(int(item["bytes"]) for item in items),
            "extractedFiles": int(old.get("extractedFiles", 0)),
        })
    manifest["years"] = years


def file_crc32(path: Path) -> str:
    checksum = 0
    with path.open("rb") as source:
        while chunk := source.read(4 * 1024 * 1024):
            checksum = zlib.crc32(chunk, checksum)
    return f"{checksum & 0xFFFFFFFF:08x}"


def format_compact_date(value: Any) -> str:
    text = str(value).replace("-", "")[:8]
    if len(text) != 8 or not text.isdigit():
        raise ValueError(f"无效交易日：{value}")
    return f"{text[:4]}-{text[4:6]}-{text[6:]}"


def validate_date(value: str) -> str:
    return date.fromisoformat(value).isoformat()


def iso_add_days(value: str, days: int) -> str:
    return (date.fromisoformat(value) + timedelta(days=days)).isoformat()


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value[:1] == value[-1:] and value[:1] in {"'", '"'}:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
