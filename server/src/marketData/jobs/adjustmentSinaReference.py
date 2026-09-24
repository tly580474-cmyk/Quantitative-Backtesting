"""Read-only independent factor-event evidence. Never write market tables."""
import concurrent.futures
import json
import pathlib
import re
import sys
import threading
import time
import urllib.request

root = pathlib.Path(sys.argv[1])
targets = json.loads((root / 'reference' / 'targets.json').read_text())
output = root / 'sina'
output.mkdir(exist_ok=True)
lock = threading.Lock()
stop = threading.Event()
next_request = 0.0
completed = 0
counts = {}


def fetch(target):
    global next_request
    path = output / f"{target['symbol']}.{target['market']}.json"
    if path.exists():
        cached = json.loads(path.read_text())
        if cached.get('status') == 'ready':
            return cached
    record = {'target': target, 'source': 'sina:qfq.js'}
    if stop.is_set():
        return None
    with lock:
        time.sleep(max(0, next_request - time.monotonic()))
        next_request = time.monotonic() + 0.3
    url = f"https://finance.sina.com.cn/realstock/company/{target['market'].lower()}{target['symbol']}/qfq.js"
    record['url'] = url
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode('utf-8')
        # Parse the JSON assignment, never execute provider JavaScript.
        match = re.search(r'=\s*(\{)', body)
        if not match:
            raise ValueError('Missing JSON factor assignment')
        # CDN responses may append a signature comment after the JSON assignment.
        payload, _ = json.JSONDecoder().raw_decode(body[match.start(1):])
        factors = payload.get('data')
        if not isinstance(factors, list) or not factors:
            raise ValueError('Empty factor reference')
        for factor in factors:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', factor.get('d', '')) or float(factor['f']) <= 0:
                raise ValueError('Invalid factor reference')
        record.update(status='ready', factors=factors)
    except Exception as error:
        record.update(status='error', error=str(error))
        if getattr(error, 'code', None) in [403, 429, 501]:
            stop.set()
    path.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')
    return record


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    pending = {}
    iterator = iter(targets)
    for target in iterator:
        pending[executor.submit(fetch, target)] = target
        if len(pending) >= 2:
            break
    failures = 0
    while pending:
        done, _ = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
        for future in done:
            del pending[future]
            result = future.result()
            if result:
                completed += 1
                status = result['status']
                counts[status] = counts.get(status, 0) + 1
                failures = failures + 1 if status == 'error' else 0
                if failures >= 10:
                    stop.set()
                if completed % 100 == 0:
                    summary = dict(completed=completed, total=len(targets), counts=counts, stopped=stop.is_set())
                    (output / 'progress.json').write_text(json.dumps(summary))
                    print(json.dumps(summary), flush=True)
            if not stop.is_set():
                target = next(iterator, None)
                if target:
                    pending[executor.submit(fetch, target)] = target
summary = dict(completed=completed, total=len(targets), counts=counts, stopped=stop.is_set())
(output / 'progress.json').write_text(json.dumps(summary))
print(json.dumps(summary), flush=True)
