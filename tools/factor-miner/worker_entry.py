"""受控 worker 入口：为 run_mining 增加跨平台内存硬限制。"""
from __future__ import annotations

import os
import runpy
import sys
import threading
import time


def _watch_memory(limit_mb: int) -> None:
    if limit_mb <= 0:
        return
    try:
        import psutil
        process = psutil.Process(os.getpid())
        limit = limit_mb * 1024 * 1024
        while True:
            rss = process.memory_info().rss
            for child in process.children(recursive=True):
                try:
                    rss += child.memory_info().rss
                except psutil.Error:
                    pass
            if rss > limit:
                print(f"WORKER_MEMORY_LIMIT_EXCEEDED rss={rss} limit={limit}",
                      file=sys.stderr, flush=True)
                os._exit(137)
            time.sleep(1.0)
    except ImportError:
        print("WORKER_MEMORY_LIMIT_UNAVAILABLE psutil is required", file=sys.stderr, flush=True)
        os._exit(126)


if __name__ == "__main__":
    limit_mb = int(os.environ.get("FACTOR_MINER_MAX_MEMORY_MB", "0") or 0)
    threading.Thread(target=_watch_memory, args=(limit_mb,), daemon=True).start()
    target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_mining.py")
    sys.argv = [target, *sys.argv[1:]]
    runpy.run_path(target, run_name="__main__")
