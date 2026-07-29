"""Stable factor-family signatures shared with the TypeScript review service."""
from __future__ import annotations

import hashlib
import json

from factor_miner.tree.ast import to_ast_expression

COMMUTATIVE_OPERATORS = {"add", "mul", "min", "max"}


def _window_bucket(window: int | None) -> str | None:
    if window is None:
        return None
    if window <= 5:
        return "very_short"
    if window <= 20:
        return "short"
    if window <= 60:
        return "medium"
    return "long"


def _stable(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _normalize_family(node: dict) -> dict:
    node_type = node.get("type")
    if node_type == "terminal":
        return {"type": "terminal", "name": node["name"]}
    if node_type == "constant":
        return {"type": "constant", "value": "*"}
    args = [_normalize_family(item) for item in node.get("args", [])]
    if node.get("op") in COMMUTATIVE_OPERATORS:
        args.sort(key=_stable)
    result = {"type": "operator", "op": node["op"], "args": args}
    if "window" in node:
        result["window"] = _window_bucket(int(node["window"]))
    return result


def candidate_family_signature(node, direction: str) -> str | None:
    try:
        ast = to_ast_expression(node)
    except ValueError:
        return None
    payload = {"direction": direction, "root": _normalize_family(ast["root"])}
    return hashlib.sha256(_stable(payload).encode("utf-8")).hexdigest()


def is_blocked_direction(node, rankic: float, cfg: dict) -> bool:
    blocked = set(cfg.get("search_memory", {}).get("blocked_family_signatures") or [])
    if not blocked:
        return False
    direction = "lower-is-better" if rankic < 0 else "higher-is-better"
    signature = candidate_family_signature(node, direction)
    return bool(signature and signature in blocked)
