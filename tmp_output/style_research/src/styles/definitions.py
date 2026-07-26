"""5 种投资风格的定义。

每种风格定义:
- style_id: 唯一标识
- style_name: 中文名
- risk_level: 风险等级
- target_horizon: 评估用持有期
- weight_horizon: 权重计算用 horizon(通常=target_horizon)
- factor_ids: 因子子集
- directions: 覆盖因子默认 direction(主观,符合风格理念)
- auto_calibrate: 是否启用数据驱动方向校准(覆盖主观 directions)
- description: 描述

设计要点:
1. 因子方向主观设定,符合风格理念(如趋势型用 higher,价值型用 lower)
2. 不修改因子文件中的默认 direction,通过本定义覆盖
3. CompositeScorer 的 factor_directions 参数接收本定义的 directions 字典
4. auto_calibrate=True 时,StyleScorer 会用 avg_rank_ic 的符号覆盖主观 directions
   (IC>0 → HIGHER, IC<0 → LOWER),用于 A 股呈反转效应时纠正主观方向
"""

from __future__ import annotations

from dataclasses import dataclass

from src.factors.base import FactorDirection


@dataclass(frozen=True)
class StyleSpec:
    """投资风格规格定义。"""

    style_id: str
    style_name: str
    risk_level: str
    target_horizon: int
    weight_horizon: int
    factor_ids: tuple[str, ...]
    directions: dict[str, str]
    auto_calibrate: bool = False
    weighting: str = "icir"  # P2: "icir"(|rank_ic_ir|加权) 或 "equal"(等权)
    description: str = ""


# 公共方向常量
HIGHER = FactorDirection.HIGHER_IS_BETTER
LOWER = FactorDirection.LOWER_IS_BETTER


# ========== 1. 逆向抄底(基线,直接复用现有评分) ==========
CONTRARIAN_SPEC = StyleSpec(
    style_id="contrarian",
    style_name="逆向抄底",
    risk_level="进取",
    target_horizon=5,
    weight_horizon=5,
    factor_ids=(
        # 现有 26 个有效因子(排除 dividend_yield)
        "ma60_slope_5d", "ma20_above_ma60", "price_above_ma20", "short_ma_slope",
        "return_10d", "return_20d", "distance_to_20d_high", "consecutive_down_days",
        "volume_ratio", "up_vs_down_volume", "amount_20d_avg", "breakout_20d",
        "higher_lows", "contraction", "bullish_candle_ratio",
        "macd_histogram", "rsi_14",
        "drawdown_20d", "consecutive_large_bearish",
        "pe_ttm", "pb", "ps_ttm", "pe_change_5d",
        "log_market_cap", "log_float_market_cap",
        "turnover_rate",
    ),
    directions={
        # 使用数据驱动校准的 direction(来自 technical.py / fundamental.py)
        "ma60_slope_5d": LOWER, "ma20_above_ma60": LOWER,
        "price_above_ma20": LOWER, "short_ma_slope": LOWER,
        "return_10d": LOWER, "return_20d": LOWER,
        "distance_to_20d_high": FactorDirection.RESEARCH,
        "consecutive_down_days": HIGHER,
        "volume_ratio": LOWER, "up_vs_down_volume": LOWER,
        "amount_20d_avg": LOWER, "breakout_20d": LOWER,
        "higher_lows": LOWER, "contraction": HIGHER,
        "bullish_candle_ratio": LOWER,
        "macd_histogram": LOWER, "rsi_14": LOWER,
        "drawdown_20d": LOWER, "consecutive_large_bearish": LOWER,
        "pe_ttm": HIGHER, "pb": HIGHER, "ps_ttm": HIGHER, "pe_change_5d": HIGHER,
        "log_market_cap": LOWER, "log_float_market_cap": LOWER,
        "turnover_rate": LOWER,
    },
    description=(
        "基线风格,与现有评分系统一致。A 股主板中期反转效应:跌深反弹、"
        "超卖修复、放量后回调。持有期 5 日,数据驱动方向 + 数据驱动权重。"
    ),
)


# ========== 2. 价值投资(稳健) ==========
# auto_calibrate=True: 单因子方向主观正确,但复合后 spread 为负
# 启用数据驱动校准以纠正复合方向偏差
VALUE_SPEC = StyleSpec(
    style_id="value",
    style_name="价值投资",
    risk_level="稳健",
    target_horizon=20,
    weight_horizon=20,
    factor_ids=(
        # 估值
        "pe_ttm", "pb", "ps_ttm", "pe_change_5d",
        # 规模(大盘稳健)
        "log_market_cap", "log_float_market_cap",
        # 流动性(低换手稳健)
        "turnover_rate",
        # 风险(低回撤稳健)
        "drawdown_20d",
    ),
    directions={
        # 价值投资核心理念:低估值、大盘、低换手、低回撤
        "pe_ttm": LOWER,             # 低估值
        "pb": LOWER,
        "ps_ttm": LOWER,
        "pe_change_5d": LOWER,       # PE 回落 = 估值修复
        "log_market_cap": HIGHER,    # 大盘稳健
        "log_float_market_cap": HIGHER,
        "turnover_rate": LOWER,      # 低换手 = 长期持有者多
        "drawdown_20d": LOWER,       # 低回撤 = 稳健
    },
    auto_calibrate=True,
    description=(
        "价值投资风格:偏好低估值、大盘、低换手、低回撤的稳健标的。"
        "持有期 20 日。auto_calibrate=True:纠正复合方向偏差。"
        "注:缺 dividend_yield、ROE,覆盖度有限。"
    ),
)


# ========== 3. 成长型(稳中求进) ==========
# auto_calibrate=True: A 股短期-中期呈反转效应,主观"高动量=高分"与实际 IC 方向相反
# (return_20d / breakout_20d / volume_ratio 等 rank_ic 均为负)
# 启用数据驱动校准后,系统会按 IC 符号自动反转方向
GROWTH_SPEC = StyleSpec(
    style_id="growth",
    style_name="成长型",
    risk_level="稳中求进",
    target_horizon=20,
    weight_horizon=20,
    factor_ids=(
        # 动量(代理成长)
        "return_20d", "momentum_60d",
        # 估值(高估值 = 成长股)
        "pe_ttm", "pe_change_5d",
        # 量能(放量 = 资金关注)
        "volume_ratio", "amount_20d_avg",
        # 趋势
        "ma60_slope_5d", "price_above_ma20",
        # 强势
        "breakout_20d", "return_10d",
    ),
    directions={
        # 主观方向(核心理念),实际会被 auto_calibrate 覆盖
        "return_20d": HIGHER,        # 动量延续 = 成长
        "momentum_60d": HIGHER,      # 长期动量 = 成长性
        "pe_ttm": HIGHER,            # 高估值 = 成长预期
        "pe_change_5d": HIGHER,      # PE 上升 = 预期强化
        "volume_ratio": HIGHER,      # 放量 = 资金关注
        "amount_20d_avg": HIGHER,
        "ma60_slope_5d": HIGHER,      # 上升趋势
        "price_above_ma20": HIGHER,
        "breakout_20d": HIGHER,
        "return_10d": HIGHER,
    },
    auto_calibrate=True,
    description=(
        "成长型风格:偏好高动量、高估值、放量上涨、趋势向上的成长股。"
        "持有期 20 日。auto_calibrate=True:因 A 股呈反转效应,主观方向需由 IC 校准。"
        "注:缺营收/利润增速,用 60 日动量代理成长性。"
    ),
)


# ========== 4. 趋势型(进取) ==========
# auto_calibrate=True: 与成长型同理,主观"均线多头/突破=高分"与实际 IC 方向相反
TREND_SPEC = StyleSpec(
    style_id="trend",
    style_name="趋势型",
    risk_level="进取",
    target_horizon=20,
    weight_horizon=20,
    factor_ids=(
        # 趋势
        "ma60_slope_5d", "ma20_above_ma60", "price_above_ma20",
        "short_ma_slope", "ma_alignment_strength",
        # 突破
        "turtle_breakout_20", "breakout_20d",
        # 动量
        "return_20d", "return_10d",
        # 波动
        "atr_20",
    ),
    directions={
        # 主观方向(核心理念),实际会被 auto_calibrate 覆盖
        "ma60_slope_5d": HIGHER,
        "ma20_above_ma60": HIGHER,
        "price_above_ma20": HIGHER,
        "short_ma_slope": HIGHER,
        "ma_alignment_strength": HIGHER,
        "turtle_breakout_20": HIGHER,
        "breakout_20d": HIGHER,
        "return_20d": HIGHER,
        "return_10d": HIGHER,
        "atr_20": HIGHER,            # 趋势活跃,波动大
    },
    auto_calibrate=True,
    description=(
        "趋势型风格:偏好均线多头排列、突破信号、趋势延续的强势股。"
        "持有期 20 日。auto_calibrate=True:主观方向与 A 股反转效应相反,需 IC 校准。"
    ),
)


# ========== 5. 短线打板(激进) ==========
# auto_calibrate=True: horizon=1d 复合评分统计意义弱,主观方向亦与 IC 反向
# 启用校准后,部分因子(如 amount_20d_avg)方向会反转
SHORT_TERM_SPEC = StyleSpec(
    style_id="short_term",
    style_name="短线打板",
    risk_level="激进",
    target_horizon=1,   # 若 1d 失效退化到 3d
    weight_horizon=1,
    factor_ids=(
        # 涨停
        "limit_up_consecutive",
        # 量能
        "volume_ratio", "amount_20d_avg", "breakout_20d",
        # 强势
        "bias_6", "kdj_j", "intraday_strength",
        # 动量
        "return_10d", "return_20d",
        # 振荡
        "rsi_14",
    ),
    directions={
        # 主观方向(核心理念),实际会被 auto_calibrate 覆盖
        "limit_up_consecutive": HIGHER,
        "volume_ratio": HIGHER,
        "amount_20d_avg": HIGHER,
        "breakout_20d": HIGHER,
        "bias_6": HIGHER,            # 偏离大 = 强势
        "kdj_j": HIGHER,             # 超买 = 强势
        "intraday_strength": HIGHER,
        "return_10d": HIGHER,
        "return_20d": HIGHER,
        "rsi_14": HIGHER,            # RSI 高 = 强势
    },
    auto_calibrate=True,
    description=(
        "短线打板风格:偏好涨停接力、量价齐升、强势延续的极端强势股。"
        "持有期 1 日(可能退化到 3 日)。auto_calibrate=True:纠正主观方向偏差。"
        "新增连板/KDJ/BIAS 因子旨在扭转 horizon=1d 失效结论。"
    ),
)


# ========== 全部风格定义 ==========
STYLE_DEFINITIONS: dict[str, StyleSpec] = {
    "contrarian": CONTRARIAN_SPEC,
    "value": VALUE_SPEC,
    "growth": GROWTH_SPEC,
    "trend": TREND_SPEC,
    "short_term": SHORT_TERM_SPEC,
}


def get_style_spec(style_id: str) -> StyleSpec:
    """获取风格规格。"""
    if style_id not in STYLE_DEFINITIONS:
        raise KeyError(
            f"未知的风格: {style_id}, 可用: {list(STYLE_DEFINITIONS.keys())}"
        )
    return STYLE_DEFINITIONS[style_id]


def list_style_ids() -> list[str]:
    """返回所有风格 ID。"""
    return list(STYLE_DEFINITIONS.keys())


__all__ = [
    "StyleSpec",
    "STYLE_DEFINITIONS",
    "CONTRARIAN_SPEC",
    "VALUE_SPEC",
    "GROWTH_SPEC",
    "TREND_SPEC",
    "SHORT_TERM_SPEC",
    "get_style_spec",
    "list_style_ids",
]
