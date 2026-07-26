"""风格评分模块。

导出 5 种投资风格定义与 StyleScorer。
"""

from __future__ import annotations

from src.styles.definitions import (
    STYLE_DEFINITIONS,
    StyleSpec,
    get_style_spec,
    list_style_ids,
)
from src.styles.style_scorer import StyleEvaluationResult, StyleScorer

__all__ = [
    "STYLE_DEFINITIONS",
    "StyleSpec",
    "StyleScorer",
    "StyleEvaluationResult",
    "get_style_spec",
    "list_style_ids",
]
