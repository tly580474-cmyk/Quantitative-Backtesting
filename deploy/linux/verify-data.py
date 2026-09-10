"""Verify all transfer manifests below the supplied root without database access."""
from pathlib import Path
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
assert str(root).startswith('/opt/quant-backtest/')
files = total = 0
for marker in sorted(root.rglob('.migration-manifests/*.json')):
    manifest = json.loads(marker.read_text())
    base = Path(manifest['destination']).resolve()
    assert base == root or root in base.parents
    for entry in manifest['files']:
        p = (base / entry['path']).resolve()
        assert base in p.parents
        assert p.stat().st_size == entry['size'], str(p)
        with p.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert digest == entry['sha256'], str(p)
        files += 1; total += entry['size']
    print('PASS', marker.name, len(manifest['files']), flush=True)
print(json.dumps({'verified_files': files, 'verified_bytes': total}))
