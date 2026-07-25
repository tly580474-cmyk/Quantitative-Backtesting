"""导出 technical.py 中每个 FactorDefinition 块的实际状态。"""
from __future__ import annotations

import re
from pathlib import Path

PATH = Path(r"D:\github_public_repo\评分规则探索\src\factors\technical.py")


def main() -> None:
    text = PATH.read_text(encoding="utf-8")
    # 找每个 class XFactor(FactorBase): 块
    pattern = re.compile(
        r'class\s+(\w+Factor)\(FactorBase\):.*?(?=\nclass\s+\w+Factor\(FactorBase\):|\n\n\n# =====)',
        re.DOTALL,
    )
    for m in pattern.finditer(text):
        block = m.group(0)
        cls_name = m.group(1)
        # 在 block 中找 id 和 direction
        id_match = re.search(r'id\s*=\s*"([^"]+)"', block)
        dir_match = re.search(r'direction\s*=\s*FactorDirection\.(\w+)', block)
        fid = id_match.group(1) if id_match else "<no id>"
        direction = dir_match.group(1) if dir_match else "<no direction>"
        print(f"{cls_name:35s} | id={fid:30s} | direction={direction}")


if __name__ == "__main__":
    main()
