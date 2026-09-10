"""Resumable directory-group transfer over SSH, with hashes of the bytes sent.

Usage: python copy-data.py SOURCE root@HOST /absolute/destination
An immutable marker is written last for each completed directory group. No deletes.
"""
from pathlib import Path
import hashlib
import io
import json
import shlex
import subprocess
import sys
import tarfile
import time

source = Path(sys.argv[1]).resolve()
host, destination = sys.argv[2:4]
assert source.is_dir()
assert destination.startswith('/opt/quant-backtest/') and '..' not in destination.split('/')
selected = next((set(arg.removeprefix('--groups=').split(',')) for arg in sys.argv[4:] if arg.startswith('--groups=')), None)
excluded = {arg for arg in sys.argv[4:] if not arg.startswith('--groups=')}
groups = [[p] for p in sorted(source.iterdir()) if p.is_dir() and not p.is_symlink() and p.name not in excluded]
groups.append([p for p in sorted(source.iterdir()) if p.is_file() and not p.is_symlink()])
subprocess.run(['ssh', host, 'mkdir -p ' + shlex.quote(destination)], check=True)
for group in groups:
    if not group: continue
    name = group[0].name if group[0].is_dir() else '__root__'
    if selected is not None and name not in selected: continue
    paths = sorted(p for base in group for p in (base.rglob('*') if base.is_dir() else [base]) if p.is_file() and not p.is_symlink())
    inventory = [{'path': p.relative_to(source).as_posix(), 'size': p.stat().st_size, 'mtime_ns': p.stat().st_mtime_ns} for p in paths]
    marker = '.migration-manifests/' + hashlib.sha256((str(source) + name).encode()).hexdigest()[:20] + '.json'
    old = subprocess.run(['ssh', host, 'cat ' + shlex.quote(destination + '/' + marker)], capture_output=True)
    if old.returncode == 0:
        saved = json.loads(old.stdout)
        if [{k: x[k] for k in ('path', 'size', 'mtime_ns')} for x in saved['files']] == inventory:
            print(f'SKIP {name}: completed unchanged group', flush=True)
            continue
    print(f'START {name}: {len(paths)} files, {sum(x["size"] for x in inventory)/1024**3:.2f} GiB', flush=True)
    child = subprocess.Popen(['ssh', '-o', 'ServerAliveInterval=30', host,
        'tar -xf - -C ' + shlex.quote(destination)], stdin=subprocess.PIPE)
    transferred = 0
    digests = {}
    reported = time.monotonic()
    class Reader:
        def __init__(self, stream): self.stream = stream; self.digest = hashlib.sha256()
        def read(self, count):
            global transferred, reported
            block = self.stream.read(count); self.digest.update(block); transferred += len(block)
            if time.monotonic() - reported > 15:
                print(f'PROGRESS {name}: {transferred/1024**3:.2f} GiB', flush=True); reported = time.monotonic()
            return block
    try:
        with tarfile.open(fileobj=child.stdin, mode='w|', bufsize=1024*1024) as archive:
            for p, entry in zip(paths, inventory):
                info = archive.gettarinfo(str(p), arcname=entry['path'])
                with p.open('rb') as stream:
                    reader = Reader(stream); archive.addfile(info, reader)
                    # tar writes hard links as a reference, so Reader is not called.
                    entry['sha256'] = digests[info.linkname] if info.islnk() else reader.digest.hexdigest()
                    digests[entry['path']] = entry['sha256']
                current = p.stat()
                if current.st_size != entry['size'] or current.st_mtime_ns != entry['mtime_ns']:
                    raise RuntimeError(f'Source changed during transfer; rerun this group: {p}')
            payload = json.dumps({'source': str(source), 'destination': destination, 'files': inventory}, ensure_ascii=True).encode()
            info = tarfile.TarInfo(marker); info.size = len(payload); info.mode = 0o600
            archive.addfile(info, io.BytesIO(payload))
        child.stdin.close()
        if child.wait() != 0: raise RuntimeError('SSH transfer failed')
    except BaseException:
        child.kill(); child.wait(); raise
    print(f'DONE {name}', flush=True)
