"""Move Codex records into a same-version native Linux schema.

The app server must be stopped. Initialize codex-check with the pinned CLI first.
Windows SQLx migration checksums differ even when normalized schemas are identical.
Keep Linux migration metadata; preserve and compare every application table row.
"""
from pathlib import Path
import json
import os
import re
import sqlite3
import subprocess

root = Path('/var/lib/quant-backtest')
backup = Path('/var/lib/quant-migration/codex-before-native-conversion')
backup.mkdir(mode=0o700, exist_ok=True)

def schema(db):
    return {name: re.sub(r'\s+', ' ', sql).strip() for name, sql in db.execute(
        "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")}

results = []
for name in ['state_5.sqlite', 'memories_1.sqlite', 'goals_1.sqlite']:
    current, native = root / 'codex-home' / name, root / 'codex-check' / name
    assert current.is_file() and native.is_file()
    assert not (backup / name).exists(), 'Conversion already attempted; inspect preserved backup'
    source, template = sqlite3.connect(current), sqlite3.connect(native)
    assert schema(source) == schema(template), f'Schemas differ: {name}'
    saved = sqlite3.connect(backup / name)
    source.backup(saved); saved.close()
    output = current.with_suffix('.native.sqlite')
    assert not output.exists()
    destination = sqlite3.connect(output)
    template.backup(destination); template.close()
    destination.execute('PRAGMA foreign_keys=OFF')
    destination.execute('BEGIN')
    tables = [row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name <> '_sqlx_migrations'")]
    counts = {}
    for table in tables:
        assert re.fullmatch(r'\w+', table)
        rows = source.execute(f'SELECT * FROM "{table}"').fetchall()
        destination.execute(f'DELETE FROM "{table}"')
        if rows:
            placeholders = ','.join('?' for _ in rows[0])
            destination.executemany(f'INSERT INTO "{table}" VALUES ({placeholders})', rows)
        copied = destination.execute(f'SELECT * FROM "{table}"').fetchall()
        assert sorted(map(repr, rows)) == sorted(map(repr, copied)), table
        counts[table] = len(rows)
    assert destination.execute('PRAGMA foreign_key_check').fetchall() == []
    assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    destination.commit(); destination.close(); source.close()
    os.replace(output, current)
    current.chmod(0o600)
    subprocess.run(['chown', 'quant:quant', str(current)], check=True)
    results.append({'database': name, 'identicalSchema': True, 'verifiedRows': counts})
Path('/var/lib/quant-migration/codex-state-conversion.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results))
