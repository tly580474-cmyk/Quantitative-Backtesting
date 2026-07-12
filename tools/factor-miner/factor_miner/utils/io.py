"""本地文件读写工具：JSON / CSV / 文本 / 目录保障。

用于因子库持久化（M3）、报告导出、配置文件加载等。
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def write_text(path: str, text: str, encoding: str = "utf-8") -> None:
    ensure_dir(os.path.dirname(path) or ".")
    with open(path, "w", encoding=encoding) as f:
        f.write(text)


def read_text(path: str, encoding: str = "utf-8") -> str:
    with open(path, "r", encoding=encoding) as f:
        return f.read()


def write_json(path: str, obj, encoding: str = "utf-8") -> None:
    ensure_dir(os.path.dirname(path) or ".")
    with open(path, "w", encoding=encoding) as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, default=str)


def read_json(path: str, encoding: str = "utf-8"):
    with open(path, "r", encoding=encoding) as f:
        return json.load(f)


def write_csv(path: str, rows: list[dict], fieldnames: list[str] | None = None) -> None:
    import csv
    ensure_dir(os.path.dirname(path) or ".")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        if rows:
            fieldnames = fieldnames or list(rows[0].keys())
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        else:
            if fieldnames:
                csv.writer(f).writerow(fieldnames)
