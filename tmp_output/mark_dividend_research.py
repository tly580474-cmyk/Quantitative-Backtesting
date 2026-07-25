"""将 dividend_yield 因子标为 RESEARCH, 明确告知框架跳过。"""
from __future__ import annotations

import re
import sys
from pathlib import Path

FUND_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\fundamental.py")


def main() -> int:
    text = FUND_PATH.read_text(encoding="utf-8")
    # 在 dividend_yield 的 FactorDefinition 块内, 把 HIGHER_IS_BETTER 改为 RESEARCH
    # 用块感知正则: id="dividend_yield" 后第一个 direction=
    pattern = re.compile(
        r'(id\s*=\s*"dividend_yield".*?direction\s*=\s*FactorDirection\.)HIGHER_IS_BETTER',
        re.DOTALL,
    )
    new_text, n = pattern.subn(r"\g<1>RESEARCH", text, count=1)
    if n == 0:
        # 可能已经是 RESEARCH 或其他方向, 用更宽松匹配
        pattern2 = re.compile(
            r'(id\s*=\s*"dividend_yield".*?direction\s*=\s*FactorDirection\.)(\w+)',
            re.DOTALL,
        )
        m = pattern2.search(text)
        if m:
            print(f"当前 direction: {m.group(2)}")
            new_text = text[: m.start()] + m.group(1) + "RESEARCH" + text[m.end() :]
            n = 1
    if n:
        FUND_PATH.write_text(new_text, encoding="utf-8")
        print(f"已将 dividend_yield 标为 RESEARCH (共 {n} 处)")
    else:
        print("未找到 dividend_yield, 跳过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
