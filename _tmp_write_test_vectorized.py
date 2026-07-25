"""写入 tests/test_vectorized.py: 验证向量化与逐日版本一致性。

每个因子用合成 K 线跑两个版本, 对比每个 (date, instrument) 的值。
允许 1e-6 相对误差(浮点)。
"""
from pathlib import Path

TARGET = Path(r"D:\github_public_repo\评分规则探索\tests")

TEST_VECT_PY = '''"""向量化版本与逐日版本一致性测试。

每个因子用合成 K 线跑 build_factor_panel(逐日) 和 build_factor_panel_vectorized,
对比每个 (date, instrument) 的值, 允许 1e-6 相对误差。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import pytest

from src.factors.registry import list_all_factor_ids
from src.panel.builder import build_factor_panel
from src.panel.vectorized import build_factor_panel_vectorized


def _make_synthetic_candles(
    n_instruments: int = 3,
    n_days: int = 80,
    seed: int = 42,
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2026-01-01", periods=n_days, freq="B").strftime("%Y-%m-%d")
    rows: list[dict[str, Any]] = []
    for i in range(n_instruments):
        inst_key = f"SH600{i:03d}"
        price = 10.0
        for d in dates:
            ret = rng.normal(0, 0.02)
            open_ = price
            close = max(0.01, open_ * (1 + ret))
            high = max(open_, close) * (1 + abs(rng.normal(0, 0.005)))
            low = min(open_, close) * (1 - abs(rng.normal(0, 0.005)))
            volume = int(1_000_000 + rng.normal(0, 200_000))
            amount = volume * close
            rows.append({
                "instrumentKey": inst_key,
                "market": "SH",
                "symbol": f"600{i:03d}",
                "name": f"A{i}",
                "industry": "测试",
                "tradeDate": d,
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
                "amount": amount,
                "turnover_rate": 1.0,
                "market_cap": 1e10,
                "float_market_cap": 5e9,
                "pe_ttm": 15.0,
                "pb": 2.0,
                "ps_ttm": 3.0,
            })
            price = close
    return pd.DataFrame(rows)


# 跳过 dividend_yield(无 dividend_yield 列, 两者都返回全 NaN, 无需对比)
SKIP_FACTORS = {"dividend_yield"}


@pytest.mark.parametrize("factor_id", [
    fid for fid in list_all_factor_ids() if fid not in SKIP_FACTORS
])
def test_vectorized_matches_sequential(factor_id: str) -> None:
    """向量化版本与逐日版本在每个 (date, instrument) 上应一致(1e-6 容差)。"""
    candles = _make_synthetic_candles(n_instruments=3, n_days=80, seed=42)
    seq = build_factor_panel(candles, factor_id)
    vec = build_factor_panel_vectorized(factor_id, candles)

    # 形状一致
    assert seq.shape == vec.shape, f"{factor_id}: shape mismatch {seq.shape} vs {vec.shape}"
    # 索引一致
    assert seq.index.equals(vec.index), f"{factor_id}: index mismatch"
    if not seq.columns.equals(vec.columns):
        # 列顺序可能不同, 对齐
        vec = vec[seq.columns]
    assert seq.columns.equals(vec.columns)

    # 逐值对比
    for col in seq.columns:
        for d in seq.index:
            sv = seq.loc[d, col]
            vv = vec.loc[d, col]
            if pd.isna(sv) and pd.isna(vv):
                continue
            if pd.isna(sv) or pd.isna(vv):
                # 两者之一 NaN, 另一非 NaN -> 失败
                pytest.fail(
                    f"{factor_id}/{d}/{col}: seq={sv} vec={vv} (一方 NaN)"
                )
            # 数值对比
            if abs(sv) < 1e-9 and abs(vv) < 1e-9:
                continue
            if not math.isclose(sv, vv, rel_tol=1e-6, abs_tol=1e-9):
                pytest.fail(
                    f"{factor_id}/{d}/{col}: seq={sv} vec={vv} (超出 1e-6 容差)"
                )


def test_vectorized_empty_input() -> None:
    empty = pd.DataFrame()
    panel = build_factor_panel_vectorized("return_10d", empty)
    assert panel.empty


def test_vectorized_unknown_factor_raises() -> None:
    candles = _make_synthetic_candles(n_instruments=2, n_days=30)
    with pytest.raises(ValueError, match="未实现向量化"):
        build_factor_panel_vectorized("nonexistent_factor", candles)


def test_build_all_factor_panels_vectorized() -> None:
    candles = _make_synthetic_candles(n_instruments=3, n_days=80)
    panels = build_factor_panel_vectorized  # noqa: F841
    from src.panel.vectorized import build_all_factor_panels_vectorized
    panels = build_all_factor_panels_vectorized(candles, factor_ids=["return_10d", "rsi_14"])
    assert set(panels.keys()) == {"return_10d", "rsi_14"}
    for fid, p in panels.items():
        assert not p.empty
'''

(TARGET / "test_vectorized.py").write_text(TEST_VECT_PY, encoding="utf-8")
print("Wrote tests/test_vectorized.py")
