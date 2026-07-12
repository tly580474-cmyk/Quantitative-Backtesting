"""pytest 公共 fixture：配置与合成面板。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent  # = .../factor_miner (包目录)
PROJECT = ROOT.parent                            # = 项目根目录
sys.path.insert(0, str(PROJECT))


def load_default_cfg() -> dict:
    with open(ROOT / "config" / "default.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


@pytest.fixture
def cfg() -> dict:
    return load_default_cfg()


@pytest.fixture
def panels() -> dict:
    from factor_miner.data.loader import make_synthetic_panel
    return make_synthetic_panel(n_symbols=40, n_dates=200, seed=1, label_window=5)
