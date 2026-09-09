from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path('/opt/quant-backtest')
server = root / 'server'
assert 'QUANT_TEST_MODE=true' in (server / '.env').read_text()
for directory in ['src/referenceData', 'src/minuteData', 'src/fundFlow']:
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', directory, '-p', '*_test.py'], cwd=server, check=True)
snapshot_root = server / 'data/research-snapshots'
snapshot_id = json.loads((snapshot_root / 'current.json').read_text())['snapshotId']
manifest = json.loads((snapshot_root / snapshot_id / 'manifest.json').read_text())
prefix = '(sub close open)'
config = dict(candidate_id='linux-synthetic-smoke', snapshot_root=str(snapshot_root), snapshot_id=snapshot_id,
    start_date=manifest['minDate'], end_date=manifest['maxDate'], prefix=prefix,
    formula_checksum=hashlib.sha256(prefix.encode()).hexdigest())
config_path = server / 'data/linux-factor-smoke.json'
config_path.write_text(json.dumps(config))
output = server / 'data/factor-research/linux-smoke'
subprocess.run([sys.executable, str(root / 'tools/factor-miner/materialize_factor.py'),
    '--config', str(config_path), '--output', str(output)], cwd=server, check=True)
import pandas as pd
frame = pd.concat([pd.read_parquet(path) for path in output.glob('year=*/data.parquet')])
assert len(frame) == 180
assert frame.factorValue.notna().all()
print('PASS Python factor materialization: 180 non-null rows from synthetic snapshot')
