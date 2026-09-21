"""Offline regression tests; no agent runtime or external data requests."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("split_skill", Path(__file__).with_name("split-a-stock-data-skill.py"))
split = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(split)

SOURCE = '''---
name: a-stock-data
description: upstream
origin: custom
version: 3.9.0
---
# 原文
Author and release history.
## When to Activate
Only when fetching data.
## Prerequisites
Dependencies.
### Shared helper
```python
## Not a Markdown section
def helper():
    return "测试"
```
## Layer 1: 行情
### 1.1 Example
```python
print(helper())
```
'''


class SplitSkillTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "original.md"
        self.source.write_bytes(SOURCE.encode())
        self.bundle = self.root / "bundle"
        self.target = self.root / "installed"
        self.target.mkdir()
        (self.target / "SKILL.md").write_bytes(self.source.read_bytes())
        self.backups = self.root / "backups"

    def build(self):
        return split.build(self.source, self.bundle)

    def test_lossless_for_all_installed_line_endings(self):
        for i, newline in enumerate(("\n", "\r\n", "\r\r\n")):
            raw = SOURCE.replace("\n", newline).encode()
            self.source.write_bytes(raw)
            info = split.build(self.source, self.root / f"build-{i}")
            self.assertEqual(info["source_sha256"], split.digest(raw))
            self.assertEqual(info["references"], 5)

    def test_tilde_fence_and_no_final_newline(self):
        self.source.write_bytes(SOURCE.replace("```", "~~~~").rstrip().encode())
        self.assertEqual(self.build()["references"], 5)

    def test_changed_reference_is_detected(self):
        info = self.build()
        reference = self.bundle / Path(info["manifest"]).parent / "04.md"
        reference.write_bytes(reference.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "Reference changed"):
            split.verify(self.bundle)

    def test_install_preserves_other_files_and_is_idempotent(self):
        self.build()
        (self.target / "LICENSE").write_text("keep")
        result = split.install(self.bundle, self.target, self.backups)
        self.assertEqual(Path(result["backup"]).read_bytes(), self.source.read_bytes())
        self.assertEqual((self.target / "LICENSE").read_text(), "keep")
        self.assertEqual((self.target / "SKILL.md").read_bytes(), (self.bundle / "SKILL.md").read_bytes())
        self.assertFalse(split.install(self.bundle, self.target, self.backups)["installed"])

    def test_source_drift_refuses_install(self):
        self.build()
        (self.target / "SKILL.md").write_text("user changed")
        with self.assertRaisesRegex(ValueError, "Installed source changed"):
            split.install(self.bundle, self.target, self.backups)
        self.assertEqual((self.target / "SKILL.md").read_text(), "user changed")

    def test_unknown_control_metadata_requires_review(self):
        self.source.write_text(SOURCE.replace("origin: custom", "origin: custom\nallowed-tools: Read"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Review new upstream metadata"):
            self.build()

    def test_existing_temp_file_is_not_removed(self):
        self.build()
        temporary = self.target / ".quant-split-entry.tmp"
        temporary.write_text("unrelated")
        with self.assertRaises(FileExistsError):
            split.install(self.bundle, self.target, self.backups)
        self.assertEqual(temporary.read_text(), "unrelated")
        self.assertEqual((self.target / "SKILL.md").read_bytes(), self.source.read_bytes())

    def test_unknown_structure_and_unclosed_fence_rejected(self):
        for text in (SOURCE.replace("## Prerequisites", "## Setup"), SOURCE + "```python\n"):
            self.source.write_text(text, encoding="utf-8")
            with self.assertRaises(ValueError):
                self.build()

    def test_backups_cannot_be_in_discoverable_skill(self):
        self.build()
        with self.assertRaisesRegex(ValueError, "Backups must be outside"):
            split.install(self.bundle, self.target, self.target / "backup")


if __name__ == "__main__":
    unittest.main()
