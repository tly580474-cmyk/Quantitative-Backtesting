from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
import json
import subprocess
import urllib.request

root = Path('/opt/quant-backtest/server')
values = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
assert values.get('QUANT_TEST_MODE') == 'true'
key = 'RESEARCH_SNAPSHOT_UPDATE_TIME'
previous = values.get(key, '18:00')
def save(value):
    request = urllib.request.Request('http://127.0.0.1:8081/api/admin/config', method='PUT',
        headers={'Authorization': 'Bearer ' + values['ADMIN_API_TOKEN'], 'Content-Type': 'application/json'},
        data=json.dumps({'updates': {key: value}}).encode())
    with urllib.request.urlopen(request) as response:
        result = json.load(response)
    assert 'quant-job@research.timer' in result['message'], result
try:
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    save(now.strftime('%H:%M'))
    subprocess.run(['systemctl', 'start', 'quant-job@research.service'], check=True)
    state = (root / '.logs/research-snapshot/research-schedule.json').read_text()
    assert state == now.strftime('%Y-%m-%d %H:%M'), repr(state)
    print('PASS management schedule update is read by real systemd job without backend restart')
finally:
    save(previous)
