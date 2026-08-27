from __future__ import annotations

import argparse
import json
import os
import queue
import random
import sqlite3
import sys
import threading
import time
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from minute_lock import MinuteUpdateLock, default_lock_path
from online_update import write_progress
from tdx_import import (
    DailyReference,
    Instrument,
    load_daily_references,
    load_instruments,
    load_latest_trading_date,
    load_trading_dates,
    minute_arrow_schema,
    open_database,
    validate_against_daily,
)
from update import (
    EXPECTED_COLUMNS,
    file_crc32,
    iso_add_days,
    latest_finalized_date,
    load_env_file,
    publish_manifest,
    validate_date,
)


class DependencyNotReadyError(RuntimeError):
    """Final daily reference data is not ready yet."""


@dataclass(frozen=True)
class TdxServer:
    name: str
    ip: str
    port: int
    latency: float | None = None

    @property
    def key(self) -> str:
        return f"{self.ip}:{self.port}"


@dataclass(frozen=True)
class FetchResult:
    symbol: str
    bars: tuple[dict[str, Any], ...]
    server: str


PREFERRED_SERVERS = (
    TdxServer("上海电信主站Z80", "180.153.18.172", 80),
    TdxServer("上海电信主站Z1", "180.153.18.170", 7709),
    TdxServer("北京联通主站Z80", "202.108.253.139", 80),
    TdxServer("杭州电信主站J1", "60.191.117.167", 7709),
    TdxServer("杭州电信主站J2", "115.238.56.198", 7709),
    TdxServer("杭州电信主站J3", "218.75.126.9", 7709),
    TdxServer("杭州电信主站J4", "115.238.90.165", 7709),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch and validate A-share 1-minute bars over the TongdaXin TCP protocol",
    )
    parser.add_argument(
        "--output-root",
        default=os.getenv("MINUTE_DATA_ROOT", "../../所有股票的历史数据/1m_price_parquet"),
    )
    parser.add_argument("--start-date", help="YYYY-MM-DD; defaults to manifest.lastDate + 1")
    parser.add_argument("--end-date", help="YYYY-MM-DD; defaults to latest finalized daily reference")
    parser.add_argument("--workers", type=int, default=int(os.getenv("MINUTE_TDX_TCP_WORKERS", "2")))
    parser.add_argument(
        "--min-servers", type=int,
        default=int(os.getenv("MINUTE_TDX_TCP_MIN_SERVERS", "2")),
    )
    parser.add_argument(
        "--max-servers", type=int,
        default=int(os.getenv("MINUTE_TDX_TCP_MAX_SERVERS", "5")),
    )
    parser.add_argument(
        "--connect-timeout", type=float,
        default=float(os.getenv("MINUTE_TDX_TCP_CONNECT_TIMEOUT_SECONDS", "3")),
    )
    parser.add_argument(
        "--page-size", type=int,
        default=int(os.getenv("MINUTE_TDX_TCP_PAGE_SIZE", "800")),
    )
    parser.add_argument(
        "--max-pages", type=int,
        default=int(os.getenv("MINUTE_TDX_TCP_MAX_PAGES", "30")),
    )
    parser.add_argument(
        "--min-coverage", type=float,
        default=float(os.getenv("MINUTE_TDX_TCP_MIN_COVERAGE", "0.995")),
    )
    parser.add_argument(
        "--checkpoint-root",
        default=os.getenv("MINUTE_TDX_TCP_CHECKPOINT_ROOT", ".logs/minute-data/checkpoints"),
    )
    parser.add_argument("--probe-symbol")
    parser.add_argument("--probe-count", type=int, default=0)
    parser.add_argument("--scan-all-servers", action="store_true")
    parser.add_argument("--shadow", action="store_true")
    parser.add_argument("--keep-checkpoint", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


class TdxCheckpoint:
    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS results (
                symbol TEXT PRIMARY KEY,
                server TEXT NOT NULL,
                payload BLOB NOT NULL,
                fetched_at REAL NOT NULL
            )
            """,
        )
        self.connection.commit()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def load(self, symbols: set[str]) -> dict[str, FetchResult]:
        if not symbols:
            return {}
        result: dict[str, FetchResult] = {}
        with self.lock:
            cursor = self.connection.execute("SELECT symbol, server, payload FROM results")
            for symbol, server, payload in cursor.fetchall():
                if symbol not in symbols:
                    continue
                bars = json.loads(zlib.decompress(payload).decode("utf-8"))
                result[symbol] = FetchResult(symbol, tuple(bars), str(server))
        return result

    def put(self, result: FetchResult) -> None:
        encoded = zlib.compress(
            json.dumps(result.bars, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            level=3,
        )
        with self.lock:
            self.connection.execute(
                """
                INSERT INTO results(symbol, server, payload, fetched_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(symbol) DO UPDATE SET
                    server=excluded.server,
                    payload=excluded.payload,
                    fetched_at=excluded.fetched_at
                """,
                (result.symbol, result.server, encoded, time.time()),
            )
            self.connection.commit()


def configured_servers() -> list[TdxServer]:
    value = os.getenv("MINUTE_TDX_TCP_SERVERS", "").strip()
    if not value:
        return list(PREFERRED_SERVERS)
    servers: list[TdxServer] = []
    for index, item in enumerate(value.split(";"), start=1):
        host, separator, port = item.strip().partition(":")
        if not separator or not host or not port.isdigit():
            raise ValueError(f"MINUTE_TDX_TCP_SERVERS 格式无效：{item}")
        servers.append(TdxServer(f"configured-{index}", host, int(port)))
    return servers


def all_servers() -> list[TdxServer]:
    result = configured_servers()
    try:
        from pytdx.config.hosts import hq_hosts
    except ImportError as error:
        raise RuntimeError(
            "缺少 pytdx；请执行 python -m pip install -r src/minuteData/requirements.txt",
        ) from error
    result.extend(TdxServer(str(name), str(ip), int(port)) for name, ip, port in hq_hosts)
    deduplicated: dict[str, TdxServer] = {}
    for server in result:
        deduplicated.setdefault(server.key, server)
    return list(deduplicated.values())


def probe_server(server: TdxServer, timeout: float) -> TdxServer | None:
    from pytdx.hq import TdxHq_API

    api = TdxHq_API(raise_exception=True)
    started = time.monotonic()
    try:
        if not api.connect(server.ip, server.port, time_out=timeout):
            return None
        bars = api.get_security_bars(8, 0, "000001", 0, 5)
        if not bars or len(bars) != 5 or not bars[-1].get("datetime"):
            return None
        return TdxServer(server.name, server.ip, server.port, time.monotonic() - started)
    except Exception:
        return None
    finally:
        try:
            api.disconnect()
        except Exception:
            pass


def discover_servers(
    *,
    timeout: float,
    min_servers: int,
    max_servers: int,
    scan_all: bool,
) -> list[TdxServer]:
    minimum = max(1, min_servers)
    maximum = max(minimum, max_servers)
    preferred = configured_servers()
    healthy = probe_servers(preferred, timeout)
    if scan_all or len(healthy) < minimum:
        known = {item.key for item in preferred}
        fallback = [item for item in all_servers() if item.key not in known]
        healthy.extend(probe_servers(fallback, timeout))
    unique = {item.key: item for item in healthy}
    ordered = sorted(unique.values(), key=lambda item: item.latency or 999.0)
    if len(ordered) < minimum:
        raise RuntimeError(
            f"TDX TCP 真实行情协议可用服务器仅 {len(ordered)} 个，"
            f"低于门槛 {minimum}",
        )
    return ordered[:maximum]


def probe_servers(servers: Iterable[TdxServer], timeout: float) -> list[TdxServer]:
    candidates = list(servers)
    if not candidates:
        return []
    healthy: list[TdxServer] = []
    with ThreadPoolExecutor(max_workers=min(12, len(candidates))) as executor:
        futures = {executor.submit(probe_server, item, timeout): item for item in candidates}
        for future in as_completed(futures):
            result = future.result()
            if result is not None:
                healthy.append(result)
    return healthy


def tdx_market(market: str) -> int:
    normalized = market.upper()
    mapping = {"SZ": 0, "SH": 1, "BJ": 2}
    if normalized not in mapping:
        raise ValueError(f"不支持的 TDX 市场：{market}")
    return mapping[normalized]


def fetch_bars_for_dates(
    api,
    instrument: Instrument,
    start_date: str,
    end_date: str,
    *,
    page_size: int = 800,
    max_pages: int = 30,
) -> list[dict[str, Any]]:
    collected: dict[str, dict[str, Any]] = {}
    count = max(1, min(800, page_size))
    for page in range(max(1, max_pages)):
        rows = api.get_security_bars(
            8, tdx_market(instrument.market), instrument.symbol, page * count, count,
        ) or []
        if not rows:
            break
        for row in rows:
            trade_time = str(row.get("datetime", ""))
            if start_date <= trade_time[:10] <= end_date:
                collected[trade_time] = dict(row)
        oldest = min(str(row.get("datetime", ""))[:10] for row in rows)
        if oldest <= start_date or len(rows) < count:
            break
    return [collected[key] for key in sorted(collected)]


def server_consistency_canary(
    *,
    servers: list[TdxServer],
    instruments: list[Instrument],
    trade_date: str,
    timeout: float,
) -> list[dict[str, Any]]:
    """Compare representative SH/SZ/BJ bars across the two fastest nodes."""
    from pytdx.hq import TdxHq_API

    if len(servers) < 2:
        return []
    representatives: list[Instrument] = []
    for market in ("SH", "SZ", "BJ"):
        match = next((item for item in instruments if item.market.upper() == market), None)
        if match is not None:
            representatives.append(match)
    samples: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for server in servers[:2]:
        api = TdxHq_API(raise_exception=True)
        try:
            if not api.connect(server.ip, server.port, time_out=timeout):
                raise RuntimeError(f"一致性抽样连接失败：{server.key}")
            for instrument in representatives:
                samples[(server.key, instrument.provider_symbol)] = fetch_bars_for_dates(
                    api, instrument, trade_date, trade_date, page_size=800, max_pages=2,
                )
        finally:
            try:
                api.disconnect()
            except Exception:
                pass
    fields = ("open", "close", "high", "low", "vol", "amount")
    reports: list[dict[str, Any]] = []
    left_server, right_server = servers[0], servers[1]
    for instrument in representatives:
        left = {
            str(row.get("datetime")): tuple(row.get(field) for field in fields)
            for row in samples.get((left_server.key, instrument.provider_symbol), [])
        }
        right = {
            str(row.get("datetime")): tuple(row.get(field) for field in fields)
            for row in samples.get((right_server.key, instrument.provider_symbol), [])
        }
        timestamps = set(left) | set(right)
        reports.append({
            "symbol": instrument.provider_symbol,
            "leftRows": len(left),
            "rightRows": len(right),
            "mismatchedRows": sum(left.get(value) != right.get(value) for value in timestamps),
        })
    return reports


def fetch_universe(
    *,
    instruments: list[Instrument],
    servers: list[TdxServer],
    start_date: str,
    end_date: str,
    workers: int,
    timeout: float,
    page_size: int,
    max_pages: int,
    checkpoint: TdxCheckpoint,
    progress_total: int | None = None,
) -> tuple[dict[str, FetchResult], dict[str, str]]:
    from pytdx.hq import TdxHq_API

    instrument_by_symbol = {item.provider_symbol: item for item in instruments}
    target_symbols = set(instrument_by_symbol)
    results = checkpoint.load(target_symbols)
    checkpoint_hits = len(results)
    tasks: queue.Queue[Instrument] = queue.Queue()
    for instrument in instruments:
        if instrument.provider_symbol not in results:
            tasks.put(instrument)
    errors: dict[str, str] = {}
    state_lock = threading.Lock()
    completed = len(results)
    started = time.monotonic()
    total = progress_total or len(instruments)

    def worker(worker_index: int) -> None:
        nonlocal completed
        current_index = worker_index % len(servers)
        api = None
        connected_server: TdxServer | None = None
        while True:
            try:
                instrument = tasks.get_nowait()
            except queue.Empty:
                break
            symbol = instrument.provider_symbol
            last_error: Exception | None = None
            for attempt in range(len(servers)):
                server = servers[(current_index + attempt) % len(servers)]
                try:
                    if api is None or connected_server is None or connected_server.key != server.key:
                        if api is not None:
                            try:
                                api.disconnect()
                            except Exception:
                                pass
                        api = TdxHq_API(raise_exception=True)
                        if not api.connect(server.ip, server.port, time_out=timeout):
                            raise RuntimeError("连接失败")
                        connected_server = server
                    bars = fetch_bars_for_dates(
                        api, instrument, start_date, end_date,
                        page_size=page_size, max_pages=max_pages,
                    )
                    result = FetchResult(symbol, tuple(bars), server.key)
                    checkpoint.put(result)
                    with state_lock:
                        results[symbol] = result
                        errors.pop(symbol, None)
                    current_index = (current_index + attempt) % len(servers)
                    break
                except Exception as error:
                    last_error = error
                    if api is not None:
                        try:
                            api.disconnect()
                        except Exception:
                            pass
                    api = None
                    connected_server = None
            else:
                with state_lock:
                    errors[symbol] = str(last_error or "未知 TDX TCP 错误")
            with state_lock:
                completed += 1
                current_completed = completed
                current_errors = len(errors)
            if current_completed % 250 == 0 or current_completed == len(instruments):
                write_progress(
                    "running", "fetching-tdx-tcp", completed=current_completed,
                    total=total, failed=current_errors,
                    message="正在通过 TDX TCP 抓取全市场分钟行情",
                )
                print(json.dumps({
                    "status": "fetching-tdx-tcp",
                    "completedSymbols": current_completed,
                    "totalSymbols": len(instruments),
                    "requestErrors": current_errors,
                    "checkpointHits": checkpoint_hits,
                    "elapsedSeconds": round(time.monotonic() - started, 1),
                }, ensure_ascii=False), flush=True)
            tasks.task_done()
        if api is not None:
            try:
                api.disconnect()
            except Exception:
                pass

    thread_count = min(max(1, workers), len(servers), max(1, tasks.qsize()))
    threads = [threading.Thread(target=worker, args=(index,), daemon=False) for index in range(thread_count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results, errors


def normalize_tdx_bars(
    instrument: Instrument,
    trade_date: str,
    bars: Iterable[dict[str, Any]],
    reference: DailyReference,
):
    import pandas as pd

    source = pd.DataFrame([
        row for row in bars if str(row.get("datetime", "")).startswith(trade_date)
    ])
    if source.empty:
        raise RuntimeError("日线有成交但 TDX TCP 目标日为空")
    source = source.sort_values("datetime").drop_duplicates("datetime", keep="last")
    if len(source) != 240:
        raise RuntimeError(f"时间轴 {len(source)} 根，期望 240 根")
    expected = expected_tdx_times(trade_date)
    actual = [f"{value}:00" for value in source["datetime"].astype(str)]
    if actual != expected:
        raise RuntimeError(
            f"时间轴不完整：first={actual[0]}, last={actual[-1]}",
        )
    required = {"open", "close", "high", "low", "vol", "amount"}
    missing = required - set(source.columns)
    if missing:
        raise RuntimeError(f"TDX TCP 缺少字段：{sorted(missing)}")
    for column in required:
        source[column] = pd.to_numeric(source[column], errors="coerce")
    if source[list(required)].isna().any().any():
        raise RuntimeError("存在空 OHLC/成交字段")
    # Some TDX quote nodes encode a zero volume/amount as the smallest positive
    # float32 denormal (commonly 5.877471754e-39). Preserve real observations,
    # but normalize protocol-level near-zero sentinels back to semantic zero.
    for column in ("vol", "amount"):
        source.loc[source[column].abs() < 1e-20, column] = 0.0
    invalid = (
        (source["low"] > source[["open", "close"]].min(axis=1))
        | (source["high"] < source[["open", "close"]].max(axis=1))
        | (source["high"] < source["low"])
        | (source["vol"] < 0)
        | (source["amount"] < 0)
    )
    if invalid.any():
        raise RuntimeError(f"有 {int(invalid.sum())} 行违反 OHLC/成交约束")

    frame = source[["datetime", "open", "close", "high", "low", "vol", "amount"]].copy()
    frame.insert(0, "code", instrument.provider_symbol)
    frame["trade_time"] = frame["datetime"].astype(str) + ":00"
    frame["date"] = trade_date.replace("-", "")
    frame["pre_close"] = frame["close"].shift(1)
    first_pre_close = reference.previous_close
    if first_pre_close is None:
        first_pre_close = float(frame.iloc[0]["open"])
    frame.loc[frame.index[0], "pre_close"] = first_pre_close
    frame["change"] = frame["close"] - frame["pre_close"]
    frame["pct_chg"] = frame["change"] / frame["pre_close"] * 100
    frame.loc[frame["pre_close"] == 0, "pct_chg"] = float("nan")
    frame["__index_level_0__"] = range(len(frame))
    verified = validate_against_daily(
        instrument.provider_symbol, trade_date, frame, reference,
    )
    result = frame[EXPECTED_COLUMNS].reset_index(drop=True)
    result.attrs["daily_verified"] = verified
    return result


def expected_tdx_times(trade_date: str) -> list[str]:
    from datetime import date, datetime, time as clock_time, timedelta

    values: list[str] = []
    for start, end in (
        (clock_time(9, 31), clock_time(11, 30)),
        (clock_time(13, 1), clock_time(15, 0)),
    ):
        cursor = datetime.combine(date(2000, 1, 1), start)
        finish = datetime.combine(date(2000, 1, 1), end)
        while cursor <= finish:
            values.append(f"{trade_date} {cursor:%H:%M}:00")
            cursor += timedelta(minutes=1)
    return values


def validate_and_collect_date(
    *,
    trade_date: str,
    expected_symbols: set[str],
    instrument_by_symbol: dict[str, Instrument],
    references: dict[tuple[str, str], DailyReference],
    responses: dict[str, FetchResult],
    request_errors: dict[str, str],
    min_coverage: float,
    enforce_coverage: bool = True,
) -> tuple[list[Any], dict[str, str], list[str]]:
    frames: list[Any] = []
    errors: dict[str, str] = {}
    unverified: list[str] = []
    for symbol in sorted(expected_symbols):
        response = responses.get(symbol)
        if response is None:
            errors[symbol] = request_errors.get(symbol, "TDX TCP 无响应")
            continue
        try:
            frame = normalize_tdx_bars(
                instrument_by_symbol[symbol], trade_date, response.bars,
                references[(symbol, trade_date)],
            )
            if not frame.attrs.get("daily_verified", False):
                unverified.append(symbol)
            frames.append(frame)
        except Exception as error:
            errors[symbol] = str(error)
    coverage = len(frames) / len(expected_symbols) if expected_symbols else 0.0
    if enforce_coverage and coverage < min_coverage:
        raise RuntimeError(
            f"{trade_date} TDX TCP 分钟覆盖率 {coverage:.4%} "
            f"低于阈值 {min_coverage:.4%}；缺少 {len(errors)} 只："
            + "; ".join(f"{key}: {value}" for key, value in list(errors.items())[:10]),
        )
    return frames, errors, unverified


def refetch_validation_errors(
    *,
    symbols: Iterable[str],
    instrument_by_symbol: dict[str, Instrument],
    responses: dict[str, FetchResult],
    servers: list[TdxServer],
    start_date: str,
    end_date: str,
    timeout: float,
    page_size: int,
    max_pages: int,
    checkpoint: TdxCheckpoint,
) -> dict[str, str]:
    """Refetch malformed or mismatched symbols from a different healthy node."""
    from pytdx.hq import TdxHq_API

    outcomes: dict[str, str] = {}
    for symbol in symbols:
        original_server = responses.get(symbol).server if symbol in responses else None
        alternatives = [server for server in servers if server.key != original_server]
        last_error: Exception | None = None
        for server in alternatives:
            api = TdxHq_API(raise_exception=True)
            try:
                if not api.connect(server.ip, server.port, time_out=timeout):
                    raise RuntimeError("连接失败")
                bars = fetch_bars_for_dates(
                    api, instrument_by_symbol[symbol], start_date, end_date,
                    page_size=page_size, max_pages=max_pages,
                )
                result = FetchResult(symbol, tuple(bars), server.key)
                responses[symbol] = result
                checkpoint.put(result)
                outcomes[symbol] = server.key
                break
            except Exception as error:
                last_error = error
            finally:
                try:
                    api.disconnect()
                except Exception:
                    pass
        else:
            outcomes[symbol] = f"failed: {last_error or '无备用服务器'}"
    return outcomes


def publish_tdx_date(
    *,
    output_root: Path,
    manifest: dict[str, Any],
    trade_date: str,
    frames: list[Any],
    errors: dict[str, str],
    unverified: list[str],
    expected_symbols: set[str],
    servers: list[TdxServer],
    run_id: str,
    overwrite: bool,
) -> dict[str, Any]:
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    if not frames:
        raise RuntimeError(f"{trade_date} 没有可发布的 TDX TCP 分钟数据")
    result = pd.concat(frames, ignore_index=True).sort_values(["code", "trade_time"])
    for column in (
        "close", "open", "high", "low", "vol", "amount", "pre_close", "change", "pct_chg",
    ):
        result[column] = result[column].astype("float32")
    result["__index_level_0__"] = result["__index_level_0__"].astype("int64")
    target = output_root / f"year={trade_date[:4]}" / f"{trade_date.replace('-', '')}.parquet"
    if target.exists() and not overwrite:
        raise RuntimeError(f"目标文件已存在；如需重建请传 --overwrite：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".parquet.tdx-online-partial")
    temporary.unlink(missing_ok=True)
    table = pa.Table.from_pandas(
        result[EXPECTED_COLUMNS], schema=minute_arrow_schema(pa), preserve_index=False,
    )
    pq.write_table(table, temporary, compression="snappy")
    parquet = pq.ParquetFile(temporary)
    if parquet.metadata.num_rows != len(frames) * 240:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"{trade_date} TDX TCP 写盘行数校验失败")
    if parquet.schema_arrow.names != EXPECTED_COLUMNS:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"{trade_date} TDX TCP 写盘字段校验失败")
    del parquet
    os.replace(temporary, target)
    entry = {
        "date": trade_date,
        "relativePath": f"year={trade_date[:4]}/{target.name}",
        "bytes": target.stat().st_size,
        "crc32": file_crc32(target),
        "source": "tdx-online:tcp",
        "runId": run_id,
        "serverCount": len(servers),
    }
    publish_manifest(output_root, manifest, entry)
    coverage = len(frames) / len(expected_symbols)
    payload = {
        "date": trade_date,
        "symbols": len(frames),
        "rows": len(result),
        "coverage": round(coverage, 6),
        "missingSymbols": len(errors),
        "unverifiedDailyChecks": len(unverified),
        "bytes": entry["bytes"],
        "missingSamples": list(errors)[:20],
    }
    print(json.dumps({"status": "published-tdx-tcp", **payload}, ensure_ascii=False), flush=True)
    return payload


def main() -> int:
    load_env_file(Path.cwd() / ".env")
    args = parse_args()
    run_id = uuid.uuid4().hex
    output_root = Path(args.output_root).resolve()
    manifest = json.loads((output_root / "manifest.json").read_text(encoding="utf-8"))
    manifest_last_date = max(str(item["date"]) for item in manifest["files"])
    finalized = latest_finalized_date()
    connection = open_database()
    try:
        expected_last_date = load_latest_trading_date(connection, finalized)
        requested_start = validate_date(args.start_date) if args.start_date else None
        requested_end = validate_date(args.end_date) if args.end_date else None
        if args.shadow or args.probe_symbol or args.probe_count > 0:
            start_date = requested_start or expected_last_date
        else:
            start_date = requested_start or iso_add_days(manifest_last_date, 1)
        end_date = requested_end or expected_last_date
        if start_date > end_date:
            print(json.dumps({
                "status": "up-to-date",
                "manifestLastDate": manifest_last_date,
                "expectedLastTradingDate": expected_last_date,
                "latestFinalizedDate": finalized,
            }, ensure_ascii=False))
            return 0
        trading_dates = load_trading_dates(connection, start_date, end_date)
        instruments = load_instruments(connection, start_date, end_date)
        references = load_daily_references(connection, start_date, end_date)
    finally:
        connection.close()
    existing_dates = {str(item["date"]) for item in manifest["files"]}
    pending_dates = trading_dates if args.shadow else [
        day for day in trading_dates if args.overwrite or day not in existing_dates
    ]
    if not pending_dates:
        print(json.dumps({
            "status": "up-to-date", "manifestLastDate": manifest_last_date,
            "expectedLastTradingDate": expected_last_date,
        }, ensure_ascii=False))
        return 0
    expected_by_date = {
        day: {
            symbol for (symbol, reference_day), reference in references.items()
            if reference_day == day and reference.volume > 0
        }
        for day in pending_dates
    }
    missing_reference_dates = [day for day, symbols in expected_by_date.items() if not symbols]
    if missing_reference_dates:
        raise DependencyNotReadyError(
            "最终日线尚未准备好：" + ", ".join(missing_reference_dates),
        )
    instrument_by_symbol = {item.provider_symbol: item for item in instruments}
    target_symbols = sorted(set().union(*expected_by_date.values()))
    missing_instruments = [symbol for symbol in target_symbols if symbol not in instrument_by_symbol]
    if missing_instruments:
        raise RuntimeError("数据库股票主表缺少代码：" + ", ".join(missing_instruments[:20]))
    target_instruments = [instrument_by_symbol[symbol] for symbol in target_symbols]
    plan = {
        "runId": run_id,
        "outputRoot": str(output_root),
        "manifestLastDate": manifest_last_date,
        "expectedLastTradingDate": expected_last_date,
        "pendingDates": pending_dates,
        "symbols": len(target_symbols),
        "workers": max(1, args.workers),
        "minCoverage": args.min_coverage,
        "shadow": bool(args.shadow),
    }
    if args.dry_run:
        print(json.dumps({"status": "planned", **plan}, ensure_ascii=False))
        return 0

    write_progress(
        "running", "discovering-tdx-servers", completed=0,
        total=len(target_symbols), message="正在探测 TDX TCP 行情服务器",
    )

    servers = discover_servers(
        timeout=max(0.5, args.connect_timeout),
        min_servers=max(1, args.min_servers),
        max_servers=max(1, args.max_servers),
        scan_all=bool(args.scan_all_servers),
    )
    print(json.dumps({
        "status": "tdx-server-health",
        "healthyServers": len(servers),
        "servers": [{
            "name": item.name, "address": item.key,
            "latencyMs": round((item.latency or 0) * 1000, 1),
        } for item in servers],
    }, ensure_ascii=False), flush=True)
    canary = server_consistency_canary(
        servers=servers,
        instruments=target_instruments,
        trade_date=pending_dates[-1],
        timeout=max(0.5, args.connect_timeout),
    )
    print(json.dumps({
        "status": "tdx-server-consistency-canary",
        "servers": [item.key for item in servers[:2]],
        "samples": canary,
    }, ensure_ascii=False), flush=True)

    if args.probe_symbol:
        normalized = args.probe_symbol.strip().upper().split(".")[0]
        matches = [item for item in target_instruments if item.symbol == normalized]
        if len(matches) != 1:
            raise RuntimeError(f"找不到唯一的有成交探针股：{args.probe_symbol}")
        target_instruments = matches
        target_symbols = [matches[0].provider_symbol]
    elif args.probe_count > 0:
        count = min(max(1, args.probe_count), len(target_instruments))
        target_instruments = random.Random(20260827).sample(target_instruments, count)
        target_symbols = [item.provider_symbol for item in target_instruments]

    checkpoint_root = Path(args.checkpoint_root).resolve()
    checkpoint_path = checkpoint_root / (
        f"tdx-online-{pending_dates[0].replace('-', '')}-{pending_dates[-1].replace('-', '')}.sqlite3"
    )
    checkpoint = TdxCheckpoint(checkpoint_path)
    try:
        responses, request_errors = fetch_universe(
            instruments=target_instruments,
            servers=servers,
            start_date=pending_dates[0],
            end_date=pending_dates[-1],
            workers=max(1, args.workers),
            timeout=max(0.5, args.connect_timeout),
            page_size=max(1, args.page_size),
            max_pages=max(1, args.max_pages),
            checkpoint=checkpoint,
        )
        reports = []
        for day in pending_dates:
            expected = expected_by_date[day] & set(target_symbols)
            frames, errors, unverified = validate_and_collect_date(
                trade_date=day,
                expected_symbols=expected,
                instrument_by_symbol=instrument_by_symbol,
                references=references,
                responses=responses,
                request_errors=request_errors,
                min_coverage=args.min_coverage,
                enforce_coverage=False,
            )
            retry_candidates = [symbol for symbol in errors if symbol in responses]
            if retry_candidates:
                retry_outcomes = refetch_validation_errors(
                    symbols=retry_candidates,
                    instrument_by_symbol=instrument_by_symbol,
                    responses=responses,
                    servers=servers,
                    start_date=pending_dates[0],
                    end_date=pending_dates[-1],
                    timeout=max(0.5, args.connect_timeout),
                    page_size=max(1, args.page_size),
                    max_pages=max(1, args.max_pages),
                    checkpoint=checkpoint,
                )
                print(json.dumps({
                    "status": "tdx-validation-refetch",
                    "date": day,
                    "symbols": len(retry_candidates),
                    "outcomes": retry_outcomes,
                }, ensure_ascii=False), flush=True)
                frames, errors, unverified = validate_and_collect_date(
                    trade_date=day,
                    expected_symbols=expected,
                    instrument_by_symbol=instrument_by_symbol,
                    references=references,
                    responses=responses,
                    request_errors=request_errors,
                    min_coverage=args.min_coverage,
                )
            else:
                coverage = len(frames) / len(expected) if expected else 0.0
                if coverage < args.min_coverage:
                    raise RuntimeError(
                        f"{day} TDX TCP 分钟覆盖率 {coverage:.4%} "
                        f"低于阈值 {args.min_coverage:.4%}；缺少 {len(errors)} 只："
                        + "; ".join(
                            f"{key}: {value}" for key, value in list(errors.items())[:10]
                        ),
                    )
            coverage = len(frames) / len(expected) if expected else 0.0
            report = {
                "date": day, "symbols": len(frames), "expectedSymbols": len(expected),
                "rows": len(frames) * 240, "coverage": round(coverage, 6),
                "missingSymbols": len(errors),
                "unverifiedDailyChecks": len(unverified),
                "missingSamples": list(errors)[:20],
            }
            if args.shadow or args.probe_symbol or args.probe_count > 0:
                reports.append(report)
                print(json.dumps({"status": "tdx-shadow-validated", **report}, ensure_ascii=False))
            else:
                reports.append(publish_tdx_date(
                    output_root=output_root,
                    manifest=manifest,
                    trade_date=day,
                    frames=frames,
                    errors=errors,
                    unverified=unverified,
                    expected_symbols=expected,
                    servers=servers,
                    run_id=run_id,
                    overwrite=args.overwrite,
                ))
        probe_mode = bool(args.probe_symbol or args.probe_count > 0)
        final_status = "shadow-ready" if args.shadow else "probe-ready" if probe_mode else "ready"
        progress_phase = (
            "tdx-shadow-completed" if args.shadow
            else "tdx-probe-completed" if probe_mode
            else "tdx-update-completed"
        )
        print(json.dumps({
            "status": final_status,
            **plan,
            "healthyServers": len(servers),
            "reports": reports,
            "checkpoint": str(checkpoint_path),
        }, ensure_ascii=False))
        write_progress(
            "completed", progress_phase,
            completed=sum(report["symbols"] for report in reports),
            total=sum(report.get("expectedSymbols", report["symbols"]) for report in reports),
            failed=sum(report.get("missingSymbols", 0) for report in reports),
            message=(
                "TDX TCP 分钟行情影子验证完成" if args.shadow
                else "TDX TCP 分钟行情探针完成" if probe_mode
                else "TDX TCP 分钟行情更新完成"
            ),
        )
    finally:
        checkpoint.close()
    if not (args.shadow or args.keep_checkpoint or args.probe_symbol or args.probe_count > 0):
        checkpoint_path.unlink(missing_ok=True)
        checkpoint_path.with_suffix(checkpoint_path.suffix + "-wal").unlink(missing_ok=True)
        checkpoint_path.with_suffix(checkpoint_path.suffix + "-shm").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    try:
        load_env_file(Path.cwd() / ".env")
        args_preview = parse_args()
        if args_preview.shadow or args_preview.probe_symbol or args_preview.probe_count > 0 or args_preview.dry_run:
            raise SystemExit(main())
        with MinuteUpdateLock(default_lock_path(), "tdx-online"):
            raise SystemExit(main())
    except DependencyNotReadyError as error:
        write_progress("pending", "waiting-daily-reference", message=str(error))
        print(json.dumps({
            "status": "dependency-pending", "dependency": "final-daily-bars",
            "error": str(error),
        }, ensure_ascii=False))
        raise SystemExit(3)
    except Exception as error:
        write_progress("failed", "tdx-tcp-failed", message=str(error))
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
