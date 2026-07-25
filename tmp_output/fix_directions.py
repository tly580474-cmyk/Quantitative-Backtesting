"""修正因子方向标注。

依据 5 年评估报告 (tmp_output/SCORE_EVALUATION_REPORT_5Y.md) 中各因子的
rank_ic_ir 符号, 系统性修正 direction 字段:
- |rank_ic_ir| >= 1.5 且为负: 翻转方向 (HIGHER<->LOWER, RESEARCH->对应方向)
- |rank_ic_ir| < 1.5 或无数据: 改为 RESEARCH (弱信号)
- 唯一正向因子 consecutive_down_days (+1.21): 保留 HIGHER_IS_BETTER

修正后期望复合评分多空价差由 -0.43% 转为正值。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TECH_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\technical.py")
FUND_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\fundamental.py")


# (factor_id, 旧 direction, 新 direction, 原因)
TECH_FIXES = [
    # 趋势类 (4 个) - 全部反转
    ("ma60_slope_5d", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-4.51"),
    ("ma20_above_ma60", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-4.40"),
    ("price_above_ma20", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-4.48"),
    ("short_ma_slope", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-4.04"),
    # 动量类 (4 个)
    ("return_10d", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-4.02"),
    ("return_20d", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-5.10"),
    ("distance_to_20d_high", "HIGHER_IS_BETTER", "RESEARCH", "rank_ic_ir=+0.53 (弱)"),
    ("consecutive_down_days", "HIGHER_IS_BETTER", "HIGHER_IS_BETTER", "rank_ic_ir=+1.21 (唯一正向, 保留)"),
    # 量能类 (4 个) - 全部反转
    ("volume_ratio", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-4.73"),
    ("up_vs_down_volume", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-3.64"),
    ("amount_20d_avg", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-7.03"),
    ("breakout_20d", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-8.64"),
    # 形态类 (3 个)
    ("higher_lows", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-2.27"),
    ("contraction", "LOWER_IS_BETTER", "HIGHER_IS_BETTER", "rank_ic_ir=-4.77 (反向, 实为扩张更好)"),
    ("bullish_candle_ratio", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-3.43"),
    # 振荡类 (2 个)
    ("macd_histogram", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-2.51"),
    ("rsi_14", "RESEARCH", "LOWER_IS_BETTER", "rank_ic_ir=-5.14"),
    # 风险类 (2 个)
    ("drawdown_20d", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-1.64 (回撤越大未来越差)"),
    ("consecutive_large_bearish", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-3.42"),
]

FUND_FIXES = [
    ("pe_ttm", "LOWER_IS_BETTER", "HIGHER_IS_BETTER", "rank_ic_ir=-2.38 (价值陷阱)"),
    ("pb", "LOWER_IS_BETTER", "HIGHER_IS_BETTER", "rank_ic_ir=-4.67 (价值陷阱)"),
    ("ps_ttm", "LOWER_IS_BETTER", "HIGHER_IS_BETTER", "rank_ic_ir=-3.63 (价值陷阱)"),
    ("log_market_cap", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-2.70 (小盘效应)"),
    ("turnover_rate", "RESEARCH", "LOWER_IS_BETTER", "rank_ic_ir=-5.85 (低换手更优)"),
    # dividend_yield: 数据缺失保留原方向, 后续补充数据后再评估
    ("pe_change_5d", "LOWER_IS_BETTER", "HIGHER_IS_BETTER", "rank_ic_ir=-3.36"),
    ("log_float_market_cap", "HIGHER_IS_BETTER", "LOWER_IS_BETTER", "rank_ic_ir=-2.26 (小盘效应)"),
]


def apply_fixes(path: Path, fixes: list[tuple[str, str, str, str]]) -> int:
    """对 path 文件应用方向修正, 返回修改数量。"""
    text = path.read_text(encoding="utf-8")
    original = text
    changes = 0

    for factor_id, old_dir, new_dir, reason in fixes:
        if old_dir == new_dir:
            print(f"  [SKIP] {factor_id}: 保留 {old_dir} ({reason})")
            continue

        # 定位: 在 id="xxx" 之后的第一个 direction=FactorDirection.XXX
        # 用 .*? (DOTALL) 跨行匹配, lazy 保证匹配最近的 direction=
        # 注意: description 可能含 ')', 所以不能用 [^)]*?
        pattern = re.compile(
            rf'(id\s*=\s*"{re.escape(factor_id)}".*?direction\s*=\s*FactorDirection\.){old_dir}',
            re.DOTALL,
        )
        new_text, n = pattern.subn(rf"\g<1>{new_dir}", text, count=1)
        if n == 0:
            print(f"  [FAIL] {factor_id}: 未找到 {old_dir} (检查 id 或 direction 写法)")
            continue
        text = new_text
        changes += 1
        print(f"  [OK]   {factor_id}: {old_dir} -> {new_dir}  ({reason})")

    if text != original:
        path.write_text(text, encoding="utf-8")
        print(f"  -> 已写回 {path.name}, 修改 {changes} 处")
    else:
        print(f"  -> 无变更 ({path.name})")
    return changes


def main() -> int:
    print("=" * 70)
    print("修正 technical.py")
    print("=" * 70)
    n1 = apply_fixes(TECH_PATH, TECH_FIXES)
    print()
    print("=" * 70)
    print("修正 fundamental.py")
    print("=" * 70)
    n2 = apply_fixes(FUND_PATH, FUND_FIXES)
    print()
    print(f"总计修改: {n1 + n2} 处")
    return 0


if __name__ == "__main__":
    sys.exit(main())
