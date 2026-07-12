"""进化检查点：断点保存 / 恢复，保证长任务崩溃后可续跑。

状态对象需为可 pickle 的结构（建议把公式树序列化为前缀表达式字符串，
再在恢复时解析回树，避免 __slots__ 类版本演化带来的兼容问题）。
"""
from __future__ import annotations

import logging
import os
import pickle

logger = logging.getLogger("factor_miner")


def save_checkpoint(path: str, state: dict) -> bool:
    """原子保存检查点：先写临时文件再 rename，避免半截文件。"""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            pickle.dump(state, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
        logger.debug("检查点已保存: %s", path)
        return True
    except Exception as exc:  # pragma: no cover
        logger.warning("检查点保存失败: %s", exc)
        return False


def load_checkpoint(path: str):
    """读取检查点；不存在或失效时返回 None。"""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as f:
            return pickle.load(f)
    except Exception as exc:  # pragma: no cover
        logger.warning("检查点读取失败，将从头开始: %s", exc)
        return None


def clear_checkpoint(path: str) -> None:
    for p in (path, path + ".tmp"):
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:  # pragma: no cover
                pass
