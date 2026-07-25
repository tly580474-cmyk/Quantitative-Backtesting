"""块感知的因子方向修正。

之前的 .*? 正则会跨因子匹配, 导致:
- distance_to_20d_high 应为 RESEARCH, 实际为 LOWER
- consecutive_down_days 应为 HIGHER, 实际为 LOWER
- drawdown_20d 应为 LOWER, 实际为 RESEARCH

本脚本用 class 边界严格隔离每个 FactorDefinition 块, 只在块内替换。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TECH_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\technical.py")
FUND_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\fundamental.py")


# 当前文件状态 -> 目标状态 (3 个错误项 + 验证其他)
TECH_TARGETS: dict[str, str] = {
    "ma60_slope_5d": "LOWER_IS_BETTER",
    "ma20_above_ma60": "LOWER_IS_BETTER",
    "price_above_ma20": "LOWER_IS_BETTER",
    "short_ma_slope": "LOWER_IS_BETTER",
    "return_10d": "LOWER_IS_BETTER",
    "return_20d": "LOWER_IS_BETTER",
    "distance_to_20d_high": "RESEARCH",  # 修复: 当前为 LOWER, 应为 RESEARCH
    "consecutive_down_days": "HIGHER_IS_BETTER",  # 修复: 当前为 LOWER, 应为 HIGHER
    "volume_ratio": "LOWER_IS_BETTER",
    "up_vs_down_volume": "LOWER_IS_BETTER",
    "amount_20d_avg": "LOWER_IS_BETTER",
    "breakout_20d": "LOWER_IS_BETTER",
    "higher_lows": "LOWER_IS_BETTER",
    "contraction": "HIGHER_IS_BETTER",
    "bullish_candle_ratio": "LOWER_IS_BETTER",
    "macd_histogram": "LOWER_IS_BETTER",
    "rsi_14": "LOWER_IS_BETTER",
    "drawdown_20d": "LOWER_IS_BETTER",  # 修复: 当前为 RESEARCH, 应为 LOWER
    "consecutive_large_bearish": "LOWER_IS_BETTER",
}

FUND_TARGETS: dict[str, str] = {
    "pe_ttm": "HIGHER_IS_BETTER",
    "pb": "HIGHER_IS_BETTER",
    "ps_ttm": "HIGHER_IS_BETTER",
    "log_market_cap": "LOWER_IS_BETTER",
    "turnover_rate": "LOWER_IS_BETTER",
    "dividend_yield": "HIGHER_IS_BETTER",  # 保留
    "pe_change_5d": "HIGHER_IS_BETTER",
    "log_float_market_cap": "LOWER_IS_BETTER",
}


def fix_block_aware(path: Path, targets: dict[str, str]) -> int:
    """对每个 factor_id, 在其所属 FactorDefinition 块内替换 direction。

    块边界: 从 id="xxx" 行向上找到 return FactorDefinition( , 向下找到该调用的
    闭合 ). 用括号深度计数定位闭合, 避免误伤 description 中的括号。
    """
    text = path.read_text(encoding="utf-8")
    changes = 0

    for factor_id, target_dir in targets.items():
        # Step 1: 找 id="factor_id" 的位置
        id_pattern = re.compile(rf'id\s*=\s*"{re.escape(factor_id)}"')
        id_match = id_pattern.search(text)
        if not id_match:
            print(f"  [FAIL] {factor_id}: 未找到 id")
            continue

        # Step 2: 向前找最近的 return FactorDefinition( 作为块开始
        # 向后找该调用的闭合 )
        # 简化: 块 = [FactorDefinition(...)], 用括号深度定位
        # 从 id_match.start() 向前找 "FactorDefinition("
        prefix = text[: id_match.start()]
        block_start = prefix.rfind("FactorDefinition(")
        if block_start == -1:
            print(f"  [FAIL] {factor_id}: 未找到 FactorDefinition( 块开始")
            continue
        # FactorDefinition( 后第一个 ( 是块开始位置
        paren_open = block_start + len("FactorDefinition")  # 指向 "("

        # Step 3: 从 paren_open 起用括号深度找匹配的 )
        depth = 0
        i = paren_open
        in_string = False
        string_char = None
        block_end = -1
        while i < len(text):
            ch = text[i]
            if in_string:
                if ch == "\\":
                    i += 2
                    continue
                if ch == string_char:
                    in_string = False
            else:
                if ch in ('"', "'"):
                    in_string = True
                    string_char = ch
                elif ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        block_end = i + 1
                        break
            i += 1

        if block_end == -1:
            print(f"  [FAIL] {factor_id}: 未找到 FactorDefinition 块结束")
            continue

        block = text[block_start:block_end]

        # Step 4: 在块内替换 direction=FactorDirection.XXX
        dir_pattern = re.compile(r"(direction\s*=\s*FactorDirection\.)(\w+)")
        m = dir_pattern.search(block)
        if not m:
            print(f"  [FAIL] {factor_id}: 块内未找到 direction")
            continue

        current_dir = m.group(2)
        if current_dir == target_dir:
            print(f"  [SKIP] {factor_id}: 已是 {target_dir}")
            continue

        # 在 block 内替换 (只替换第一次)
        new_block = block[: m.start()] + m.group(1) + target_dir + block[m.end() :]
        text = text[:block_start] + new_block + text[block_end:]
        changes += 1
        print(
            f"  [OK]   {factor_id}: {current_dir} -> {target_dir}"
        )

    if changes:
        path.write_text(text, encoding="utf-8")
        print(f"  -> 已写回 {path.name}, 修改 {changes} 处")
    else:
        print(f"  -> 无变更 ({path.name})")
    return changes


def main() -> int:
    print("=" * 70)
    print("块感知修复 technical.py")
    print("=" * 70)
    n1 = fix_block_aware(TECH_PATH, TECH_TARGETS)
    print()
    print("=" * 70)
    print("块感知修复 fundamental.py")
    print("=" * 70)
    n2 = fix_block_aware(FUND_PATH, FUND_TARGETS)
    print()
    print(f"总计修改: {n1 + n2} 处")
    return 0


if __name__ == "__main__":
    sys.exit(main())
