"""Repair legacy empty hard-link digests, then independently verify on destination.

Run on the Windows source after transfers finish. No data files are modified.
"""
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys

host = sys.argv[1]
scan = "import pathlib,json; print(json.dumps([{'path':str(p),'manifest':json.loads(p.read_text())} for p in pathlib.Path('/opt/quant-backtest').rglob('.migration-manifests/*.json')]))"
markers = json.loads(subprocess.check_output(['ssh', host, 'python3 -c ' + shlex.quote(scan)]))
empty = hashlib.sha256(b'').hexdigest()
fixed = 0
for item in markers:
    manifest = item['manifest']
    source = Path(manifest['source'])
    changed = False
    for entry in manifest['files']:
        if entry['size'] and entry['sha256'] == empty:
            p = source / entry['path']
            before = p.stat()
            assert before.st_size == entry['size'] and before.st_mtime_ns == entry['mtime_ns'], str(p)
            with p.open('rb') as stream: entry['sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
            after = p.stat()
            assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns), str(p)
            changed = True
            fixed += 1
    if changed:
        command = 'cat > ' + shlex.quote(item['path'])
        subprocess.run(['ssh', host, command], input=json.dumps(manifest, ensure_ascii=True).encode(), check=True)
print('Repaired hard-link digests:', fixed)
