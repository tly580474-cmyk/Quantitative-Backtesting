"""Restore only a dedicated test database, then remove it. Never connects to production."""
from pathlib import Path
import subprocess
import json

root = Path('/opt/quant-backtest/server')
database = 'quant_backtest_linux_test_restore_check'
existing = subprocess.check_output(['mysql', '-N', '-e', f"SHOW DATABASES LIKE '{database}'"], text=True).strip()
if existing:
    raise SystemExit('Existing restore database preserved; choose a clean test VM')
subprocess.run(['mysql', '-e', f"GRANT ALL ON `{database}`.* TO 'quant_test'@'127.0.0.1'"], check=True)
manifests = sorted((root / 'data/backups').glob('*/backup-manifest.json'))
assert manifests
manifest = json.loads(manifests[-1].read_text())
assert manifest['database']['name'] == 'quant_backtest_linux_test'
for args in [ ['backup:verify', '--', '--path', str(manifests[-1].parent)],
              ['backup:restore-check', '--', '--path', str(manifests[-1].parent), '--database', database, '--confirm-drop', database, '--cleanup', 'true'] ]:
    subprocess.run(['sudo', '-u', 'quant', 'npm', 'run', *args], cwd=root, check=True)
