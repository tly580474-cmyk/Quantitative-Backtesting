"""Generate 30 synthetic minute bars, then run the real ZIP-to-lake preparation."""
from pathlib import Path
import subprocess
import sys
import zipfile
import pandas as pd

root = Path('/opt/quant-backtest/server')
assert 'QUANT_TEST_MODE=true' in (root / '.env').read_text()
rows = []
for symbol in ['000001.SZ', '600000.SH', '000002.SZ']:
    for minute in range(30, 40):
        rows.append(dict(code=symbol, trade_time=f'2026-07-24 09:{minute}:00', open=10.0, high=10.1,
            low=9.9, close=10.0, vol=100.0, amount=1000.0, date='2026-07-24', pre_close=10.0,
            change=0.0, pct_chg=0.0, __index_level_0__=len(rows)))
zip_root = root / 'data/minute-zip'
zip_root.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(zip_root / '2026.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('20260724.parquet', pd.DataFrame(rows).to_parquet(index=False))
subprocess.run([sys.executable, 'src/minuteData/prepare.py', '--zip-root', str(zip_root),
    '--output-root', str(root / 'data/minute-parquet'), '--start-year', '2026', '--end-year', '2026'], cwd=root, check=True)
print('Generated 30 synthetic minute bars')
