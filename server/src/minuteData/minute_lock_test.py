from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from minute_lock import MinuteUpdateLock, MinuteUpdateLockedError


class MinuteUpdateLockTest(unittest.TestCase):
    def test_excludes_second_writer_and_releases(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "minute.lock"
            with MinuteUpdateLock(path, "first"):
                with self.assertRaises(MinuteUpdateLockedError):
                    MinuteUpdateLock(path, "second").acquire()
            with MinuteUpdateLock(path, "second"):
                self.assertTrue(path.exists())
            self.assertFalse(path.exists())

    def test_reclaims_recent_lock_from_dead_process(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "minute.lock"
            path.write_text(json.dumps({
                "token": "dead", "owner": "dead", "pid": 99999999,
            }), encoding="utf-8")
            with patch("minute_lock.process_exists", return_value=False):
                with MinuteUpdateLock(path, "replacement", stale_after_seconds=60):
                    self.assertTrue(path.exists())

    def test_keeps_recent_malformed_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "minute.lock"
            path.write_text("", encoding="utf-8")
            with patch("minute_lock.time.time", return_value=path.stat().st_mtime + 30):
                with self.assertRaises(MinuteUpdateLockedError):
                    MinuteUpdateLock(path, "replacement", stale_after_seconds=60).acquire()


if __name__ == "__main__":
    unittest.main()
