from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any


class MinuteUpdateLockedError(RuntimeError):
    """Another minute-lake writer currently owns the shared lock."""


class MinuteUpdateLock:
    def __init__(
        self,
        path: Path,
        owner: str,
        *,
        stale_after_seconds: float = 8 * 60 * 60,
    ) -> None:
        self.path = path.resolve()
        self.owner = owner
        self.stale_after_seconds = max(60.0, stale_after_seconds)
        self.token = uuid.uuid4().hex
        self.acquired = False

    def __enter__(self) -> "MinuteUpdateLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release()

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                descriptor = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                )
            except FileExistsError:
                existing = read_lock_payload(self.path)
                if not lock_is_stale(self.path, existing, self.stale_after_seconds):
                    raise MinuteUpdateLockedError(
                        "分钟湖写入锁已被占用："
                        f"{existing.get('owner', 'unknown')} pid={existing.get('pid', 'unknown')}",
                    )
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    pass
                continue
            payload = {
                "token": self.token,
                "owner": self.owner,
                "pid": os.getpid(),
                "startedAt": time.time(),
            }
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            self.acquired = True
            return
        raise MinuteUpdateLockedError(f"无法获取分钟湖写入锁：{self.path}")

    def release(self) -> None:
        if not self.acquired:
            return
        existing = read_lock_payload(self.path)
        if existing.get("token") == self.token:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
        self.acquired = False


def default_lock_path() -> Path:
    configured = os.getenv("MINUTE_UPDATE_LOCK_FILE", "").strip()
    return Path(configured or ".logs/minute-data/update.lock")


def read_lock_payload(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (FileNotFoundError, OSError, ValueError):
        return {}


def lock_is_stale(path: Path, payload: dict[str, Any], stale_after_seconds: float) -> bool:
    pid = payload.get("pid")
    if isinstance(pid, int) and pid > 0 and process_exists(pid):
        return False
    try:
        age = time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return True
    return age >= stale_after_seconds or not isinstance(pid, int)


def process_exists(pid: int) -> bool:
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True

