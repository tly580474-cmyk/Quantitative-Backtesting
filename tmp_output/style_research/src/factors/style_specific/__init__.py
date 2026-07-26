"""风格专属因子模块。

导出 8 个新增 K 线衍生因子:
- 趋势(3): atr_20 / turtle_breakout_20 / ma_alignment_strength
- 短线(4): limit_up_consecutive / kdj_j / bias_6 / intraday_strength
- 成长(1): momentum_60d

不修改现有 src/factors/registry.py,本模块独立提供 STYLE_SPECIFIC_FACTORS 列表
与 build_style_registry() 函数,供 styles 子系统使用。
"""

from __future__ import annotations

from src.factors.base import FactorRegistry
from src.factors.style_specific.growth import GROWTH_FACTORS
from src.factors.style_specific.shortterm import SHORTTERM_FACTORS
from src.factors.style_specific.trend import TREND_FACTORS


# 全部新增因子(8 个)
STYLE_SPECIFIC_FACTORS = TREND_FACTORS + SHORTTERM_FACTORS + GROWTH_FACTORS


def build_style_registry() -> FactorRegistry:
    """构建风格专属因子注册表。"""
    registry = FactorRegistry()
    for factor in STYLE_SPECIFIC_FACTORS:
        registry.register(factor)
    return registry


def list_style_factor_ids() -> list[str]:
    """返回所有风格专属因子 ID。"""
    return [f.definition().id for f in STYLE_SPECIFIC_FACTORS]


__all__ = [
    "STYLE_SPECIFIC_FACTORS",
    "build_style_registry",
    "list_style_factor_ids",
    "TREND_FACTORS",
    "SHORTTERM_FACTORS",
    "GROWTH_FACTORS",
]
