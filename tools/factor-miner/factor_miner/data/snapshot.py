"""读取主项目已发布、不可变的 Parquet 研究快照。"""
from __future__ import annotations

import hashlib
import json
import logging
import random
from pathlib import Path

import pandas as pd
import pyarrow.dataset as ds

logger = logging.getLogger("factor_miner")

SNAPSHOT_COLUMNS = [
    "instrumentKey", "market", "symbol", "name", "industry", "tradeDate",
    "open", "high", "low", "close", "previousClose", "volume", "amount",
    "turnoverRatePct", "totalMarketCap", "peTtm", "pb", "psTtm",
]


def read_published_snapshot(cfg: dict) -> tuple[pd.DataFrame, dict]:
    data_cfg = cfg["data"]
    root = Path(data_cfg["snapshot_root"]).expanduser().resolve()
    pointer = _read_json(root / "current.json")
    snapshot_id = data_cfg.get("snapshot_id") or pointer.get("snapshotId")
    if not snapshot_id or not isinstance(snapshot_id, str):
        raise ValueError("研究快照 current.json 缺少 snapshotId")
    snapshot_root = root / snapshot_id
    manifest = _read_json(snapshot_root / "manifest.json")
    _validate_manifest({"snapshotId": snapshot_id}, manifest)

    start = str(data_cfg.get("start_date") or manifest["minDate"])
    end = str(data_cfg.get("end_date") or manifest["maxDate"])
    selected = [p for p in manifest["partitions"]
                if p["maxDate"] >= start and p["minDate"] <= end]
    if not selected:
        raise ValueError(f"研究快照在 {start}～{end} 没有可用分区")
    paths = [snapshot_root / p["relativePath"] for p in selected]
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(f"研究快照分区不存在: {path}")
    if data_cfg.get("verify_snapshot_checksums", False):
        for partition, path in zip(selected, paths):
            actual = _sha256(path)
            if actual != partition["sha256"]:
                raise ValueError(f"研究快照分区校验和不一致: {path}")

    dataset = ds.dataset([str(path) for path in paths], format="parquet")
    date_filter = ((ds.field("tradeDate") >= pd.Timestamp(start).date())
                   & (ds.field("tradeDate") <= pd.Timestamp(end).date()))
    symbol_filter = None
    sample_n = int(data_cfg.get("sample_symbols") or data_cfg.get("gp_panel_symbols") or 0)
    if sample_n > 0:
        symbol_table = dataset.to_table(columns=["instrumentKey"], filter=date_filter)
        keys = sorted(set(symbol_table.column("instrumentKey").to_pylist()))
        if sample_n < len(keys):
            rng = random.Random(data_cfg.get("sample_seed", cfg["evolution"].get("seed", 0)))
            keys = rng.sample(keys, sample_n)
        symbol_filter = ds.field("instrumentKey").isin(keys)
    table_filter = date_filter if symbol_filter is None else date_filter & symbol_filter
    requested_columns = data_cfg.get("snapshot_columns")
    columns = SNAPSHOT_COLUMNS if requested_columns is None else list(dict.fromkeys(requested_columns))
    unknown = sorted(set(columns) - set(SNAPSHOT_COLUMNS))
    if unknown:
        raise ValueError(f"研究快照包含未知请求列: {', '.join(unknown)}")
    frame = dataset.to_table(columns=columns, filter=table_filter).to_pandas()
    if frame.empty:
        raise ValueError("研究快照筛选后没有数据")
    logger.info("已读取发布快照 %s：%d 行，%d 个标的", snapshot_id, len(frame),
                frame["instrumentKey"].nunique())
    list_dates = None
    if int(data_cfg.get("universe", {}).get("recent_listing_days", 0) or 0) > 0:
        all_paths = [snapshot_root / p["relativePath"] for p in manifest["partitions"]]
        history = ds.dataset([str(path) for path in all_paths], format="parquet")
        keys = frame["instrumentKey"].drop_duplicates().tolist()
        history_table = history.to_table(columns=["instrumentKey", "tradeDate"],
                                         filter=ds.field("instrumentKey").isin(keys))
        history_frame = history_table.to_pandas()
        list_dates = history_frame.groupby("instrumentKey")["tradeDate"].min().to_dict()
    return _map_snapshot_columns(frame, list_dates), {
        "snapshot_id": snapshot_id,
        "source_version": manifest["sourceVersion"],
        "manifest_created_at": manifest["createdAt"],
        "row_count": len(frame),
        "partition_count": len(selected),
    }


def _map_snapshot_columns(df: pd.DataFrame, list_dates: dict | None = None) -> pd.DataFrame:
    out = df.rename(columns={
        "tradeDate": "trade_date", "turnoverRatePct": "turnover",
        "totalMarketCap": "market_cap", "peTtm": "pe_ttm", "psTtm": "ps_ttm",
    }).copy()
    out["list_date"] = out["instrumentKey"].map(list_dates) if list_dates is not None else pd.NaT
    out["symbol"] = out["market"].astype(str) + "." + out["symbol"].astype(str)
    out["is_st"] = out["name"].fillna("").astype(str).str.upper().str.contains("ST").astype(int)
    out["inst_type"] = "stock"
    out["delist_date"] = pd.NaT
    return out


def _validate_manifest(pointer: dict, manifest: dict) -> None:
    if manifest.get("schemaVersion") != 1 or manifest.get("status") != "validated":
        raise ValueError("研究快照 manifest 未通过校验")
    if pointer.get("snapshotId") != manifest.get("snapshotId"):
        raise ValueError("研究快照指针与 manifest 不一致")
    partitions = manifest.get("partitions") or []
    if sum(int(item["rows"]) for item in partitions) != int(manifest.get("rowCount", -1)):
        raise ValueError("研究快照 manifest 分区行数不一致")


def _read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
