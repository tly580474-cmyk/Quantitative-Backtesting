from __future__ import annotations

import json
import os
import tempfile
import time
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

    def test_reclaims_dead_stale_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "minute.lock"
            path.write_text(json.dumps({
                "token": "dead", "owner": "dead", "pid": 99999999,
            }), encoding="utf-8")
            old = time.time() - 120
            os.utime(path, (old, old))
            with patch("minute_lock.process_exists", return_value=False), patch(
                "minute_lock.time.time", return_value=old + 121,
            ):
                with MinuteUpdateLock(path, "replacement", stale_after_seconds=60):
                    self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
