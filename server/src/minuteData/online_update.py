from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tdx_import import (
    DailyReference,
    Instrument,
    load_daily_references,
    load_instruments,
    load_latest_trading_date,
    minute_arrow_schema,
    open_database,
)
from update import (
    EXPECTED_COLUMNS,
    file_crc32,
    latest_finalized_date,
    load_env_file,
    normalize_symbol_minutes,
    publish_manifest,
    validate_date,
)


SINA_URL = "https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData"
PROGRESS_FILE_ENV = "MINUTE_UPDATE_PROGRESS_FILE"
_progress_started_at: str | None = None


def write_progress(
    status: str,
    phase: str,
    completed: int = 0,
    total: int = 0,
    failed: int = 0,
    message: str | None = None,
) -> None:
    global _progress_started_at
    path_value = os.getenv(PROGRESS_FILE_ENV, "").strip()
    if not path_value:
        return
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if _progress_started_at is None:
        _progress_started_at = now
    payload = {
        "status": status,
        "phase": phase,
        "completed": max(0, int(completed)),
        "total": max(0, int(total)),
        "failed": max(0, int(failed)),
        "startedAt": _progress_started_at,
        "updatedAt": now,
        "finishedAt": now if status in ("completed", "failed") else None,
        "message": message,
    }
    path = Path(path_value).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


@dataclass(frozen=True)
class OnlineResult:
    symbol: str
    market: str
    name: str | None
    pre_closes: dict[str, float]
    frames: dict[str, Any]

    @property
    def provider_symbol(self) -> str:
        return f"{self.symbol}.{self.market}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Automatically fetch, validate, and publish post-close A-share minute data",
    )
    parser.add_argument(
        "--output-root",
        default=os.getenv("MINUTE_DATA_ROOT", "../../所有股票的历史数据/1m_price_parquet"),
    )
    parser.add_argument("--start-date", help="YYYY-MM-DD; recent dates only")
    parser.add_argument("--end-date", help="YYYY-MM-DD; defaults to latest finalized source date")
    parser.add_argument("--workers", type=int, default=int(os.getenv("MINUTE_ONLINE_WORKERS", "8")))
    parser.add_argument("--retries", type=int, default=int(os.getenv("MINUTE_ONLINE_RETRIES", "3")))
    parser.add_argument("--datalen", type=int, default=int(os.getenv("MINUTE_ONLINE_DATALEN", "1023")))
    parser.add_argument(
        "--min-coverage",
        type=float,
        default=float(os.getenv("MINUTE_ONLINE_MIN_COVERAGE", "0.995")),
    )
    parser.add_argument("--probe-symbol")
    parser.add_argument("--probe-count", type=int, default=0)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env_file(Path.cwd() / ".env")
    args = parse_args()
    write_progress("running", "preparing", message="正在检查交易日、清单与日线对账数据")
    output_root = Path(args.output_root).resolve()
    manifest = json.loads((output_root / "manifest.json").read_text(encoding="utf-8"))
    manifest_last_date = max(str(item["date"]) for item in manifest["files"])
    source = SinaSource(max(1, args.retries), max(241, min(1023, args.datalen)))
    source_dates = source.market_dates()
    finalized = latest_finalized_date()
    available_dates = [item for item in source_dates if item <= finalized]
    if not available_dates:
        raise RuntimeError("在线分钟源没有已终态交易日")

    requested_start = validate_date(args.start_date) if args.start_date else None
    requested_end = validate_date(args.end_date) if args.end_date else None
    start_date = requested_start or manifest_last_date
    end_date = requested_end or available_dates[-1]
    pending_dates = [
        item for item in available_dates
        if item > manifest_last_date and item >= start_date and item <= end_date
    ]
    if args.overwrite and requested_start:
        pending_dates = [
            item for item in available_dates if requested_start <= item <= end_date
        ]

    probe_date = end_date if end_date in available_dates else available_dates[-1]
    if args.probe_symbol:
        return run_probe(source, args.probe_symbol, probe_date)
    if args.probe_count > 0:
        connection = open_database()
        try:
            instruments = load_instruments(connection, probe_date, probe_date)
            references = load_daily_references(connection, probe_date, probe_date)
        finally:
            connection.close()
        traded = {
            symbol for (symbol, day), reference in references.items()
            if day == probe_date and reference.volume > 0
        }
        instruments = [item for item in instruments if item.provider_symbol in traded]
        return run_market_probe(
            source, instruments, references, probe_date, args.probe_count,
            max(1, args.workers), args.min_coverage,
        )

    connection = open_database()
    try:
        expected_last_date = load_latest_trading_date(connection, finalized)
        if not pending_dates:
            status = "source-stale" if available_dates[-1] < expected_last_date else "up-to-date"
            print(json.dumps({
                "status": status,
                "manifestLastDate": manifest_last_date,
                "sourceLastDate": available_dates[-1],
                "expectedLastTradingDate": expected_last_date,
                "latestFinalizedDate": finalized,
            }, ensure_ascii=False))
            if status == "source-stale":
                write_progress("failed", status, message="在线分钟源尚未提供最新已终态交易日")
                return 2
            write_progress("completed", status, completed=1, total=1, message="分钟湖已经是最新状态")
            return 0
        instruments = load_instruments(connection, pending_dates[0], pending_dates[-1])
        references = load_daily_references(connection, pending_dates[0], pending_dates[-1])
    finally:
        connection.close()

    expected_by_date = {
        trade_date: {
            symbol for (symbol, day), reference in references.items()
            if day == trade_date and reference.volume > 0
        }
        for trade_date in pending_dates
    }
    missing_reference_dates = [day for day, symbols in expected_by_date.items() if not symbols]
    if missing_reference_dates:
        raise RuntimeError(
            "最终日线尚未准备好，拒绝在无独立对账源时发布：" + ", ".join(missing_reference_dates),
        )

    instrument_by_symbol = {item.provider_symbol: item for item in instruments}
    target_symbols = sorted(set().union(*expected_by_date.values()))
    missing_instruments = [item for item in target_symbols if item not in instrument_by_symbol]
    if missing_instruments:
        raise RuntimeError("数据库股票主表缺少代码：" + ", ".join(missing_instruments[:20]))
    plan = {
        "outputRoot": str(output_root),
        "manifestLastDate": manifest_last_date,
        "sourceLastDate": available_dates[-1],
        "pendingDates": pending_dates,
        "symbols": len(target_symbols),
        "workers": max(1, args.workers),
        "minCoverage": args.min_coverage,
    }
    if args.dry_run:
        print(json.dumps({"status": "planned", **plan}, ensure_ascii=False))
        write_progress("completed", "planned", completed=1, total=1, message="演练计划已生成")
        return 0

    write_progress("running", "fetching-online", completed=0, total=len(target_symbols), message="正在并发抓取全市场分钟行情")
    responses, request_errors = fetch_universe(
        source,
        [instrument_by_symbol[item] for item in target_symbols],
        max(1, args.workers),
    )
    published = []
    write_progress("running", "publishing", completed=len(responses), total=len(target_symbols), failed=len(request_errors), message="抓取完成，正在校验并原子发布 Parquet")
    for trade_date in pending_dates:
        result = publish_online_date(
            output_root=output_root,
            manifest=manifest,
            trade_date=trade_date,
            expected_symbols=expected_by_date[trade_date],
            references=references,
            responses=responses,
            request_errors=request_errors,
            min_coverage=args.min_coverage,
            overwrite=args.overwrite,
        )
        published.append(result)
    print(json.dumps({
        "status": "ready",
        **plan,
        "publishedDates": len(published),
        "publishedRows": sum(int(item["rows"]) for item in published),
        "publishedBytes": sum(int(item["bytes"]) for item in published),
        "coverageWarnings": sum(int(item["missingSymbols"]) for item in published),
    }, ensure_ascii=False))
    write_progress("completed", "published", completed=len(responses), total=len(target_symbols), failed=len(request_errors), message=f"已发布 {len(published)} 个交易日")
    return 0


class SinaSource:
    def __init__(self, retries: int = 3, datalen: int = 1023) -> None:
        self.retries = retries
        self.datalen = datalen

    def market_dates(self) -> list[str]:
        errors = []
        for symbol, market in (("000001", "SZ"), ("600000", "SH"), ("920992", "BJ")):
            try:
                payload = self._request(symbol, market)
                rows = (((payload.get("result") or {}).get("data")) or [])
                dates = sorted({str(item.get("day", ""))[:10] for item in rows if item.get("day")})
                if dates:
                    return dates
                errors.append(f"{symbol}.{market}: 空数据")
            except Exception as error:
                errors.append(f"{symbol}.{market}: {error}")
        raise RuntimeError("所有交易日基准均不可用：" + "; ".join(errors))

    def fetch(self, instrument: Instrument) -> OnlineResult:
        return parse_sina_payload(
            self._request(instrument.symbol, instrument.market),
            instrument.symbol,
            instrument.market,
        )

    def _request(self, symbol: str, market: str) -> dict[str, Any]:
        import requests

        params = {
            "symbol": sina_symbol(symbol, market),
            "scale": "1",
            "ma": "no",
            "datalen": str(self.datalen),
        }
        last_error: Exception | None = None
        for attempt in range(self.retries):
            try:
                response = requests.get(
                    SINA_URL,
                    params=params,
                    headers={
                        "User-Agent": "Mozilla/5.0 quant-backtest-minute-updater/1.0",
                        "Referer": "https://finance.sina.com.cn/",
                    },
                    timeout=(5, 20),
                )
                response.raise_for_status()
                payload = response.json()
                status_code = (((payload.get("result") or {}).get("status") or {}).get("code"))
                if status_code not in (0, None):
                    raise RuntimeError(f"在线源返回 status.code={status_code}")
                return payload
            except Exception as error:
                last_error = error
                if attempt + 1 < self.retries:
                    time.sleep(min(4.0, 0.5 * (2 ** attempt)) + random.random() * 0.2)
        raise RuntimeError(f"在线分钟请求失败：{last_error}")


def sina_symbol(symbol: str, market: str) -> str:
    return f"{market.lower()}{symbol}"


def parse_sina_payload(payload: dict[str, Any], symbol: str, market: str) -> OnlineResult:
    import pandas as pd

    data = payload.get("result") or {}
    rows = data.get("data") or []
    frames: dict[str, list[dict[str, Any]]] = {}
    for item in rows:
        trade_time = str(item.get("day", ""))[:19]
        if len(trade_time) != 19:
            raise RuntimeError(f"{symbol}.{market} 在线分钟时间无效：{item.get('day')}")
        trade_date = trade_time[:10]
        row = {
            "trade_time": trade_time,
            "open": required_number(item.get("open"), "open"),
            "close": required_number(item.get("close"), "close"),
            "high": required_number(item.get("high"), "high"),
            "low": required_number(item.get("low"), "low"),
            "vol": required_number(item.get("volume"), "volume"),
            "amount": required_number(item.get("amount"), "amount"),
        }
        frames.setdefault(trade_date, []).append(row)
    parsed = {
        day: pd.DataFrame(rows).sort_values("trade_time").drop_duplicates("trade_time", keep="last")
        for day, rows in frames.items()
    }
    dates = sorted(parsed)
    pre_closes: dict[str, float] = {}
    for index, day in enumerate(dates):
        if index > 0:
            pre_closes[day] = float(parsed[dates[index - 1]].iloc[-1]["close"])
    return OnlineResult(
        symbol=symbol,
        market=market,
        name=None,
        pre_closes=pre_closes,
        frames=parsed,
    )


def fetch_universe(
    source: SinaSource,
    instruments: list[Instrument],
    workers: int,
) -> tuple[dict[str, OnlineResult], dict[str, str]]:
    responses: dict[str, OnlineResult] = {}
    errors: dict[str, str] = {}
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(source.fetch, item): item for item in instruments}
        for completed, future in enumerate(as_completed(futures), start=1):
            instrument = futures[future]
            try:
                responses[instrument.provider_symbol] = future.result()
            except Exception as error:
                errors[instrument.provider_symbol] = str(error)
            if completed % 250 == 0 or completed == len(instruments):
                write_progress(
                    "running", "fetching-online", completed=completed - len(errors),
                    total=len(instruments), failed=len(errors),
                    message="正在并发抓取全市场分钟行情",
                )
                print(json.dumps({
                    "status": "fetching-online",
                    "completedSymbols": completed,
                    "totalSymbols": len(instruments),
                    "requestErrors": len(errors),
                    "elapsedSeconds": round(time.monotonic() - started, 1),
                }, ensure_ascii=False), flush=True)
    return responses, errors


def publish_online_date(
    *,
    output_root: Path,
    manifest: dict[str, Any],
    trade_date: str,
    expected_symbols: set[str],
    references: dict[tuple[str, str], DailyReference],
    responses: dict[str, OnlineResult],
    request_errors: dict[str, str],
    min_coverage: float,
    overwrite: bool,
) -> dict[str, Any]:
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    frames = []
    errors: dict[str, str] = {}
    unverified: list[str] = []
    for symbol in sorted(expected_symbols):
        response = responses.get(symbol)
        if response is None:
            errors[symbol] = request_errors.get(symbol, "在线源无响应")
            continue
        raw = response.frames.get(trade_date)
        if raw is None or raw.empty:
            errors[symbol] = "日线有成交但在线分钟为空"
            continue
        reference = references[(symbol, trade_date)]
        try:
            normalized = normalize_online_minutes(
                symbol, trade_date, raw, reference.previous_close,
            )
            validate_source_frame(symbol, trade_date, normalized)
            if not reconcile_online_daily(symbol, normalized, reference):
                unverified.append(symbol)
            frames.append(normalized)
        except Exception as error:
            errors[symbol] = str(error)

    coverage = len(frames) / len(expected_symbols) if expected_symbols else 0.0
    if coverage < min_coverage:
        raise RuntimeError(
            f"{trade_date} 在线分钟覆盖率 {coverage:.4%} 低于阈值 {min_coverage:.4%}；"
            f"缺少 {len(errors)} 只：" + "; ".join(f"{k}: {v}" for k, v in list(errors.items())[:10]),
        )
    if not frames:
        raise RuntimeError(f"{trade_date} 没有可发布的在线分钟数据")
    result = pd.concat(frames, ignore_index=True).sort_values(["code", "trade_time"])
    result["__index_level_0__"] = result.groupby("code", sort=False).cumcount()
    result = result[EXPECTED_COLUMNS]
    for column in ("close", "open", "high", "low", "vol", "amount", "pre_close", "change", "pct_chg"):
        result[column] = result[column].astype("float32")
    result["__index_level_0__"] = result["__index_level_0__"].astype("int64")

    target = output_root / f"year={trade_date[:4]}" / f"{trade_date.replace('-', '')}.parquet"
    if target.exists() and not overwrite:
        raise RuntimeError(f"目标文件已存在；如需重建请传 --overwrite：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".parquet.online-partial")
    temporary.unlink(missing_ok=True)
    table = pa.Table.from_pandas(
        result,
        schema=minute_arrow_schema(pa),
        preserve_index=False,
    )
    pq.write_table(table, temporary, compression="snappy")
    parquet = pq.ParquetFile(temporary)
    actual_rows = parquet.metadata.num_rows
    actual_columns = parquet.schema_arrow.names
    del parquet
    if actual_rows != len(frames) * 240 or actual_columns != EXPECTED_COLUMNS:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"{trade_date} 在线分钟写盘校验失败")
    os.replace(temporary, target)
    entry = {
        "date": trade_date,
        "relativePath": f"year={trade_date[:4]}/{target.name}",
        "bytes": target.stat().st_size,
        "crc32": file_crc32(target),
        "source": "sina:kline-1m",
    }
    publish_manifest(output_root, manifest, entry)
    print(json.dumps({
        "status": "published-online",
        "date": trade_date,
        "symbols": len(frames),
        "rows": len(result),
        "coverage": round(coverage, 6),
        "missingSymbols": len(errors),
        "unverifiedDailyChecks": len(unverified),
        "bytes": entry["bytes"],
        "missingSamples": list(errors)[:20],
    }, ensure_ascii=False), flush=True)
    return {
        "date": trade_date,
        "rows": len(result),
        "bytes": entry["bytes"],
        "missingSymbols": len(errors),
    }


def normalize_online_minutes(symbol: str, trade_date: str, raw, pre_close: float | None):
    frame = normalize_symbol_minutes(symbol, trade_date, raw, pre_close)
    frame = frame[~frame["trade_time"].str.endswith(" 09:30:00")].reset_index(drop=True)
    return frame


def validate_source_frame(symbol: str, trade_date: str, frame) -> None:
    if len(frame) != 240:
        raise RuntimeError(f"时间轴 {len(frame)} 根，期望 240 根")
    if frame[["code", "trade_time"]].duplicated().any():
        raise RuntimeError("存在重复分钟")
    numeric = frame[["open", "high", "low", "close", "vol", "amount"]]
    if numeric.isna().any().any():
        raise RuntimeError("存在空 OHLC/成交字段")
    invalid = (
        (frame["low"] > frame[["open", "close"]].min(axis=1))
        | (frame["high"] < frame[["open", "close"]].max(axis=1))
        | (frame["high"] < frame["low"])
        | (frame["vol"] < 0)
        | (frame["amount"] < 0)
    )
    if invalid.any():
        raise RuntimeError(f"有 {int(invalid.sum())} 行违反 OHLC/成交约束")
    traded = frame[frame["vol"] > 0]
    if traded.empty:
        raise RuntimeError("日线有成交但分钟总量为 0")
    total_volume = float(traded["vol"].sum())
    total_amount = float(traded["amount"].sum())
    implied_price = total_amount / total_volume
    if implied_price < float(traded["low"].min()) * 0.98 or implied_price > float(traded["high"].max()) * 1.02:
        raise RuntimeError("日内总成交额/成交量隐含价格与价格区间不自洽")


def reconcile_online_daily(symbol: str, frame, reference: DailyReference) -> bool:
    close = float(frame.iloc[-1]["close"])
    if abs(close - reference.close) > 0.011:
        raise RuntimeError(f"收盘价 {close} 与最终日线 {reference.close} 不一致")
    actual_volume = float(frame["vol"].sum())
    expected_volume = reference.volume / 100 if symbol.startswith("688") and symbol.endswith(".SH") else reference.volume
    volume_ok = abs(actual_volume - expected_volume) <= max(10_000.0, abs(expected_volume) * 0.005)
    actual_amount = float(frame["amount"].sum())
    amount_ok = reference.amount is None or (
        abs(actual_amount - reference.amount) <= max(10_000.0, abs(reference.amount) * 0.005)
    )
    return volume_ok and amount_ok


def run_probe(source: SinaSource, symbol_input: str, trade_date: str) -> int:
    symbol, market = normalize_symbol(symbol_input)
    response = source.fetch(Instrument(symbol, market, None, None))
    raw = response.frames.get(trade_date)
    if raw is None or raw.empty:
        raise RuntimeError(f"{symbol}.{market} {trade_date} 在线分钟为空")
    pre_close = response.pre_closes.get(trade_date) or float(raw.iloc[0]["open"])
    normalized = normalize_online_minutes(f"{symbol}.{market}", trade_date, raw, pre_close)
    validate_source_frame(f"{symbol}.{market}", trade_date, normalized)
    print(json.dumps({
        "status": "probe-passed",
        "source": "sina:kline-1m",
        "providerSymbol": f"{symbol}.{market}",
        "date": trade_date,
        "rows": len(normalized),
        "firstTime": str(normalized.iloc[0]["trade_time"]),
        "lastTime": str(normalized.iloc[-1]["trade_time"]),
        "volume": float(normalized["vol"].sum()),
        "amount": float(normalized["amount"].sum()),
    }, ensure_ascii=False))
    return 0


def run_market_probe(
    source: SinaSource,
    instruments: list[Instrument],
    references: dict[tuple[str, str], DailyReference],
    trade_date: str,
    count: int,
    workers: int,
    min_coverage: float,
) -> int:
    sample_size = min(max(1, count), len(instruments))
    sample = random.Random(20260716).sample(instruments, sample_size)
    responses, request_errors = fetch_universe(source, sample, workers)
    valid = 0
    unverified = 0
    data_errors: dict[str, str] = {}
    for instrument in sample:
        symbol = instrument.provider_symbol
        response = responses.get(symbol)
        if response is None:
            continue
        raw = response.frames.get(trade_date)
        if raw is None or raw.empty:
            data_errors[symbol] = "目标交易日为空"
            continue
        try:
            reference = references[(symbol, trade_date)]
            pre_close = reference.previous_close
            frame = normalize_online_minutes(symbol, trade_date, raw, pre_close)
            validate_source_frame(symbol, trade_date, frame)
            if not reconcile_online_daily(symbol, frame, reference):
                unverified += 1
            valid += 1
        except Exception as error:
            data_errors[symbol] = str(error)
    coverage = valid / sample_size
    print(json.dumps({
        "status": "market-probe-passed" if coverage >= min_coverage else "market-probe-failed",
        "source": "sina:kline-1m",
        "date": trade_date,
        "sampledSymbols": sample_size,
        "validSymbols": valid,
        "coverage": round(coverage, 6),
        "requestErrors": len(request_errors),
        "dataErrors": len(data_errors),
        "unverifiedDailyChecks": unverified,
        "errorSamples": list({**request_errors, **data_errors}.items())[:20],
    }, ensure_ascii=False))
    return 0 if coverage >= min_coverage else 2


def normalize_symbol(value: str) -> tuple[str, str]:
    parts = value.strip().upper().split(".")
    symbol = parts[0]
    if len(parts) > 1:
        return symbol, parts[1]
    if symbol.startswith(("5", "6", "9")) and not symbol.startswith("92"):
        return symbol, "SH"
    return symbol, "BJ" if symbol.startswith(("8", "92")) else "SZ"


def required_number(value: Any, field: str) -> float:
    number = optional_number(value)
    if number is None:
        raise RuntimeError(f"在线分钟 {field} 不是有效数字：{value}")
    return number


def optional_number(value: Any) -> float | None:
    if value in (None, "", "-"):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        write_progress("failed", "failed", message=str(error))
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
