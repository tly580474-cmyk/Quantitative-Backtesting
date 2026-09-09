"""Package tracked source and Linux additions only; never include local market data or secrets."""
import pathlib
import subprocess
import tarfile
import sys

root = pathlib.Path(__file__).resolve().parents[2]
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
paths += [str(p.relative_to(root)) for p in (root / 'deploy/linux').rglob('*') if p.is_file()]
paths += ['server/scripts/linuxJob.mjs', 'server/scripts/seedLinuxTest.mjs', 'server/src/services/agent/providers/processUtils.test.ts']
paths += ['.gitattributes', 'server/src/admin/linuxJob.test.ts']
paths += [str(p.relative_to(root)) for p in (root / 'server/scripts').glob('*') if p.is_file()]
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for name in sorted(set(paths)):
        p = root / name
        if not name or not p.is_file():
            continue
        if p.name == '.env' or p.suffix in ('.mp4', '.parquet', '.duckdb', '.zip'):
            continue
        relative = p.relative_to(root)
        # factor_miner/data is Python source, not the market-data lake.
        if relative.as_posix().startswith(('server/data/', 'data/')):
            continue
        if 'experiments' in relative.parts and 'data' in relative.parts:
            continue
        if any(part in ('node_modules', '__pycache__', 'outputs', 'out', 'output', '.git', '.logs', 'tmp_output') for part in relative.parts):
            continue
        archive.add(p, arcname=p.relative_to(root), recursive=False)
print(pathlib.Path(sys.argv[1]).stat().st_size)
