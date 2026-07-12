"""日志初始化：分级输出到控制台 + 文件，配置来自 config/logging.yaml。

用法::

    from factor_miner.utils.logging import get_logger
    log = get_logger()
    log.info("进化开始")

或手动初始化::

    from factor_miner.utils.logging import setup_logging
    setup_logging(level="DEBUG", log_dir="output/logs")
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import yaml

DEFAULT_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_LOGGER_NAME = "factor_miner"


def _load_cfg() -> dict:
    cfg_path = Path(__file__).resolve().parent.parent / "config" / "logging.yaml"
    if cfg_path.exists():
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception:
            return {}
    return {}


def setup_logging(level: str | None = None, log_dir: str | None = None,
                  name: str = _LOGGER_NAME) -> logging.Logger:
    cfg = _load_cfg()
    lvl = (level or cfg.get("level", "INFO")).upper()
    ld = log_dir or cfg.get("log_dir", "output/logs")
    fmt = cfg.get("format", DEFAULT_FORMAT)

    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, lvl, logging.INFO))
    logger.handlers.clear()

    formatter = logging.Formatter(fmt)
    ch = logging.StreamHandler()
    ch.setLevel(logging.DEBUG)
    ch.setFormatter(formatter)
    logger.addHandler(ch)

    try:
        os.makedirs(ld, exist_ok=True)
        fh = logging.FileHandler(os.path.join(ld, "factor_miner.log"),
                                 encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(formatter)
        logger.addHandler(fh)
    except Exception:
        # 文件日志不可用时静默降级为仅控制台
        pass

    logger.propagate = False
    return logger


def get_logger(name: str = _LOGGER_NAME) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        return setup_logging()
    return logger
