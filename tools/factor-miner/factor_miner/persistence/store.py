"""M3 本地因子库持久化。

把通过验收（或待分析）的因子落本地，便于去重、版本管理、复用与可视化：

- **SQLite** (``factors.db``)         ：元数据 + 全部标量指标，支持去重/查询/版本。
- **Parquet** (``factor_values/*.parquet``) ：每个因子的横截面-时序取值（可选），便于复用/可视。
- **JSON**   (``traces/<run_id>.json``)      ：进化轨迹，便于复盘。

设计要点：``prefix``（前缀表达式）作为唯一键，重复因子自动去重；``version`` 字段
支持实验版本管理；``run_id`` 关联每次进化运行的轨迹，支持可追溯。
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path

import numpy as np
import pandas as pd

from factor_miner.utils.io import write_json

logger = logging.getLogger("factor_miner")


def _f(v):
    """标量指标安全转 float（None/nan/inf → None，便于 SQLite 存储）。"""
    try:
        fv = float(v)
        return fv if np.isfinite(fv) else None
    except (TypeError, ValueError):
        return None


class FactorLibrary:
    def __init__(self, root: str, version: str = "v1"):
        self.root = Path(root)
        self.version = version
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = self.root / "factors.db"
        self.values_dir = self.root / "factor_values"
        self.traces_dir = self.root / "traces"
        self.values_dir.mkdir(exist_ok=True)
        self.traces_dir.mkdir(exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db) as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS factors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    formula TEXT,
                    prefix TEXT UNIQUE,
                    train_rankic REAL, test_rankic REAL,
                    train_icir REAL, test_icir REAL,
                    test_ic_t REAL, ls_sharpe REAL, mdd REAL,
                    oos_decay REAL, mi_test REAL,
                    top_mean_ret REAL, bottom_mean_ret REAL, corr_max REAL,
                    rolling_mean REAL, rolling_min REAL,
                    test_rankic_by_window TEXT,
                    passed INTEGER,
                    version TEXT, run_id TEXT, created_at TEXT
                )
                """
            )

    # ---- 写 ----
    def exists(self, prefix: str) -> bool:
        with sqlite3.connect(self.db) as con:
            return con.execute(
                "SELECT 1 FROM factors WHERE prefix=?", (prefix,)
            ).fetchone() is not None

    def add_factor(self, rec: dict, run_id: str, store_values: bool = True) -> int | None:
        """入库单个因子；已存在（同 prefix）则去重跳过，返回 None。"""
        prefix = rec.get("prefix")
        if prefix and self.exists(prefix):
            logger.info("因子库去重跳过（已存在）: %s", rec.get("formula"))
            return None
        created = time.strftime("%Y-%m-%d %H:%M:%S")
        row = (
            rec.get("formula"), prefix,
            _f(rec.get("train_rankic")), _f(rec.get("test_rankic")),
            _f(rec.get("train_icir")), _f(rec.get("test_icir")),
            _f(rec.get("test_ic_t")), _f(rec.get("ls_sharpe")), _f(rec.get("mdd")),
            _f(rec.get("oos_decay")), _f(rec.get("mi_test")),
            _f(rec.get("top_mean_ret")), _f(rec.get("bottom_mean_ret")),
            _f(rec.get("corr_max")), _f(rec.get("rolling_mean")),
            _f(rec.get("rolling_min")),
            json.dumps(rec.get("test_rankic_by_window") or {}, ensure_ascii=False),
            1 if rec.get("passed") else 0,
            self.version, run_id, created,
        )
        with sqlite3.connect(self.db) as con:
            cur = con.execute(
                "INSERT INTO factors "
                "(formula,prefix,train_rankic,test_rankic,train_icir,test_icir,"
                "test_ic_t,ls_sharpe,mdd,oos_decay,mi_test,top_mean_ret,"
                "bottom_mean_ret,corr_max,rolling_mean,rolling_min,"
                "test_rankic_by_window,passed,version,run_id,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                row,
            )
            fid = cur.lastrowid
        fac = rec.get("factor")
        if store_values and isinstance(fac, pd.Series):
            df = fac.reset_index()
            df.columns = [df.columns[0], df.columns[1], "value"]
            df.to_parquet(self.values_dir / f"{fid}.parquet", index=False)
        logger.info("因子入库 id=%s: %s", fid, rec.get("formula"))
        return fid

    def add_trace(self, trace: list[dict], run_id: str) -> str:
        path = self.traces_dir / f"{run_id}.json"
        write_json(str(path), trace)
        return str(path)

    # ---- 读 ----
    def query(self, passed_only: bool = False) -> pd.DataFrame:
        sql = "SELECT * FROM factors"
        if passed_only:
            sql += " WHERE passed=1"
        with sqlite3.connect(self.db) as con:
            return pd.read_sql(sql, con)

    def get_factor_values(self, factor_id: int) -> pd.Series | None:
        p = self.values_dir / f"{factor_id}.parquet"
        if not p.exists():
            return None
        df = pd.read_parquet(p)
        idx = pd.MultiIndex.from_arrays([df.iloc[:, 0], df.iloc[:, 1]])
        return pd.Series(df["value"].to_numpy(dtype="float64"), index=idx, name=str(factor_id))

    def summary(self) -> dict:
        with sqlite3.connect(self.db) as con:
            total = con.execute("SELECT COUNT(*) FROM factors").fetchone()[0]
            npass = con.execute(
                "SELECT COUNT(*) FROM factors WHERE passed=1"
            ).fetchone()[0]
        return {"total": total, "passed": npass, "version": self.version,
                "db": str(self.db), "root": str(self.root)}
