"""验证因子方向标注的实际状态。"""
from __future__ import annotations

import re
from pathlib import Path

TECH_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\technical.py")
FUND_PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\fundamental.py")


def extract_directions(path: Path) -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8")
    # 匹配: id="xxx" ... direction=FactorDirection.YYY
    # 用 .*? 跨行匹配 (lazy)
    pattern = re.compile(
        r'id\s*=\s*"([^"]+)".*?direction\s*=\s*FactorDirection\.(\w+)',
        re.DOTALL,
    )
    return [(m.group(1), m.group(2)) for m in pattern.finditer(text)]


def main() -> None:
    for label, path in [("technical.py", TECH_PATH), ("fundamental.py", FUND_PATH)]:
        print(f"\n=== {label} ===")
        for fid, direction in extract_directions(path):
            print(f"  {fid:30s} -> {direction}")


if __name__ == "__main__":
    main()
