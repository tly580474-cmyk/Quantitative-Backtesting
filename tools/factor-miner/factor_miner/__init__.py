"""遗传算法自动因子挖掘系统 (Genetic Programming Alpha Miner).

纯 Python 实现的遗传规划（GP）引擎，从 A 股日频量价数据自动进化出
可解释、低相关、样本外有效的选股因子表达式。
"""

__version__ = "0.1.0"

PACKAGE_NAME = "factor_miner"

# 遗传规划中 NaN/inf 是常态（由 protect/适应度层统一清洗），屏蔽该特定
# RuntimeWarning 以免淹没真实进度日志；不影响其它告警。
import warnings

warnings.filterwarnings(
    "ignore", category=RuntimeWarning, message="invalid value encountered in sqrt"
)
