"""pytest 引导: 用 importlib 将 style_research 模块注入 src.* 命名空间。

背景:
- 评分规则探索 中存在空的 src/factors/style_specific/__init__.py(由目录创建副作用产生)
- 直接用 sys.path + __path__ 扩展,Python 仍优先找到空 __init__.py
- 解决方案: 用 importlib 显式加载 style_research 中的模块文件,注入 sys.modules

工作原理:
1. sys.path 只加 评分规则探索 (用于 src.factors.base 等基础模块)
2. 用 importlib.util.spec_from_file_location 加载 style_research 的模块
3. 注入到 sys.modules['src.factors.style_specific'] 等
4. 之后 `from src.factors.style_specific import ...` 会从 sys.modules 命中
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

STYLE_RESEARCH_ROOT = Path(__file__).resolve().parent
EXPLORATION_ROOT = Path("d:/github_public_repo/评分规则探索")

# Step 1: 只加 评分规则探索 到 sys.path
if str(EXPLORATION_ROOT) not in sys.path:
    sys.path.insert(0, str(EXPLORATION_ROOT))

# Step 2: 导入 src 基础包(从 评分规则探索)
import src  # noqa: E402
import src.factors  # noqa: E402
import src.panel  # noqa: E402


def _load_package(file_path: Path, module_name: str) -> None:
    """加载一个包(目录 + __init__.py)到 sys.modules。

    设置 submodule_search_locations 让子模块自动可被导入。
    """
    spec = importlib.util.spec_from_file_location(
        module_name,
        file_path,
        submodule_search_locations=[str(file_path.parent)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {module_name} 从 {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)


def _load_module(file_path: Path, module_name: str) -> None:
    """加载单个模块文件到 sys.modules。"""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {module_name} 从 {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)


# Step 3: 加载 style_research 的模块,覆盖空 __init__.py
style_src = STYLE_RESEARCH_ROOT / "src"

# src.factors.style_specific (包,自动加载 trend/shortterm/growth 子模块)
_load_package(
    style_src / "factors" / "style_specific" / "__init__.py",
    "src.factors.style_specific",
)

# src.panel.vectorized_styles (单文件)
_load_module(
    style_src / "panel" / "vectorized_styles.py",
    "src.panel.vectorized_styles",
)

# src.styles (包,自动加载 definitions/style_scorer 子模块)
_load_package(
    style_src / "styles" / "__init__.py",
    "src.styles",
)
