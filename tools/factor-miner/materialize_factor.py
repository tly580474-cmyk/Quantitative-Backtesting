"""将冻结的复杂候选公式离线物化为按年分区的因子值 Parquet。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from factor_miner.data.loader import _to_panel
from factor_miner.data.snapshot import read_published_snapshot
from factor_miner.engine.evaluator import evaluate_tree
from factor_miner.tree.serialize import from_prefix


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _required_warmup(node) -> int:
    child = max((_required_warmup(item) for item in node.children), default=0)
    if node.kind == "function" and str(node.name).startswith("ts_") and node.children:
        window_node = node.children[-1]
        window = int(round(float(window_node.value))) if window_node.is_constant() else 0
        return child + max(0, window)
    return child


def _terminal_names(node) -> set[str]:
    if node.kind == "terminal":
        return set() if node.is_constant() else {str(node.name)}
    result: set[str] = set()
    for child in node.children:
        result.update(_terminal_names(child))
    return result


def _snapshot_columns(terminals: set[str]) -> list[str]:
    columns = {"instrumentKey", "market", "symbol", "name", "industry", "tradeDate"}
    direct = {
        "open": "open", "high": "high", "low": "low", "close": "close",
        "volume": "volume", "amount": "amount", "turnover": "turnoverRatePct",
    }
    for terminal in terminals:
        if terminal in direct:
            columns.add(direct[terminal])
        elif terminal == "vwap":
            columns.update(("amount", "volume", "close"))
        elif terminal == "returns":
            columns.add("close")
        elif terminal == "log_mktcap":
            columns.add("totalMarketCap")
        else:
            raise ValueError(f"物化器不支持终端字段: {terminal}")
    return sorted(columns)


def _build_materialization_panel(raw: pd.DataFrame, terminals: set[str]) -> pd.DataFrame:
    raw = raw.sort_values(["symbol", "trade_date"]).reset_index(drop=True)
    grouped = raw.groupby("symbol", group_keys=False)
    if "vwap" in terminals:
        raw["vwap"] = (raw["amount"] / raw["volume"].replace(0, np.nan)).fillna(raw["close"])
    if "returns" in terminals:
        raw["returns"] = grouped["close"].pct_change()
    if "log_mktcap" in terminals:
        raw["log_mktcap"] = np.log(raw["market_cap"].clip(lower=1.0))
        raw["log_mktcap"] = raw.groupby("trade_date")["log_mktcap"].transform(
            lambda values: values.fillna(values.median()))
    if "turnover" in terminals:
        raw["turnover"] = raw.groupby("trade_date")["turnover"].transform(
            lambda values: values.fillna(values.median()))
    return _to_panel(raw)


def materialize(config: dict, output: Path) -> dict:
    started = time.perf_counter()
    node = from_prefix(config["prefix"])
    terminals = _terminal_names(node)
    warmup = max(int(config.get("warmup_days") or 0), _required_warmup(node))
    start = date.fromisoformat(config["start_date"])
    source_start = start - timedelta(days=max(30, warmup * 3))
    panel_config = {
        "data": {
            "source": "snapshot",
            "snapshot_root": config["snapshot_root"],
            "snapshot_id": config["snapshot_id"],
            "start_date": source_start.isoformat(),
            "end_date": config["end_date"],
            "sample_symbols": 0,
            "gp_panel_symbols": 0,
            "sample_seed": 0,
            "label_window": 5,
            "label_windows": [5],
            "use_adjusted": False,
            "verify_snapshot_checksums": False,
            "snapshot_columns": _snapshot_columns(terminals),
            "universe": {"recent_listing_days": 0},
        },
        "evolution": {"seed": 0},
    }
    raw, lineage = read_published_snapshot(panel_config)
    panel = _build_materialization_panel(raw, terminals)
    values = evaluate_tree(node, panel)
    if not isinstance(values, pd.Series):
        values = pd.Series(values, index=panel.index, dtype="float64")
    dates = values.index.get_level_values("trade_date")
    selected = (dates >= pd.Timestamp(config["start_date"])) & (dates <= pd.Timestamp(config["end_date"]))
    values = values[selected].replace([np.inf, -np.inf], np.nan)
    aligned = panel.reindex(values.index)
    frame = pd.DataFrame({
        "tradeDate": values.index.get_level_values("trade_date").date,
        "instrumentKey": aligned["instrumentKey"].to_numpy(),
        "factorValue": values.to_numpy(dtype="float64"),
    })
    if frame.empty or frame["factorValue"].notna().sum() == 0:
        raise ValueError("复杂因子物化后没有有效取值")

    staging = output.with_name(output.name + f".staging-{os.getpid()}")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    partitions = []
    for year, part in frame.groupby(pd.to_datetime(frame["tradeDate"]).dt.year, sort=True):
        directory = staging / f"year={int(year)}"
        directory.mkdir()
        path = directory / "data.parquet"
        part.to_parquet(path, index=False, compression="zstd")
        partitions.append({
            "year": int(year), "relativePath": path.relative_to(staging).as_posix(),
            "rows": len(part), "sha256": _sha256(path),
        })
    manifest = {
        "schemaVersion": 1,
        "status": "validated",
        "candidateId": config["candidate_id"],
        "snapshotId": config["snapshot_id"],
        "formulaChecksum": config["formula_checksum"],
        "startDate": config["start_date"],
        "endDate": config["end_date"],
        "rowCount": len(frame),
        "validValueCount": int(frame["factorValue"].notna().sum()),
        "backend": "cpu-pandas",
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "sourceLineage": lineage,
        "partitions": partitions,
    }
    (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if output.exists():
        shutil.rmtree(output)
    # Windows Store Python 可能拒绝目录级 os.replace；shutil.move 会在此情形下
    # 自动退化为复制后删除。调用方只会在进程成功退出后读取 manifest。
    shutil.move(str(staging), str(output))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    print(json.dumps(materialize(config, Path(args.output).resolve()), ensure_ascii=False))


if __name__ == "__main__":
    main()
