from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


class MinutePrepareTest(unittest.TestCase):
    def test_preserves_incremental_files_outside_the_year_zip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="minute-prepare-") as temporary:
            root = Path(temporary)
            zip_root = root / "zip"
            output_root = root / "lake"
            zip_root.mkdir()
            incremental_root = output_root / "year=2026"
            incremental_root.mkdir(parents=True)
            with zipfile.ZipFile(zip_root / "2026.zip", "w") as archive:
                archive.writestr("20260102.parquet", b"archive-day")
            (incremental_root / "20260105.parquet").write_bytes(b"incremental-day")

            subprocess.run([
                sys.executable,
                str(Path(__file__).with_name("prepare.py")),
                "--zip-root", str(zip_root),
                "--output-root", str(output_root),
                "--start-year", "2026",
                "--end-year", "2026",
            ], check=True, capture_output=True, text=True)
            manifest = json.loads((output_root / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual([item["date"] for item in manifest["files"]], [
                "2026-01-02", "2026-01-05",
            ])
            self.assertEqual(manifest["files"][1]["source"], "incremental")


if __name__ == "__main__":
    unittest.main()
