import time, random, json, sys
import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
S = requests.Session()
S.headers.update({"User-Agent": UA, "Referer": "https://quote.eastmoney.com/"})
_last = [0.0]

def em_get(url, params):
    wait = 1.2 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait + random.uniform(0.1, 0.4))
    try:
        return S.get(url, params=params, timeout=15)
    finally:
        _last[0] = time.time()

def board_flow(fs_name, fs, pz):
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": "1", "pz": str(pz), "po": "1", "np": "1",
        "fltt": "2", "invt": "2", "fid": "f62", "fs": fs,
        "fields": "f12,f14,f2,f3,f62,f184,f66,f72,f78,f84",
    }
    r = em_get(url, params)
    d = r.json()
    diff = (d.get("data") or {}).get("diff") or []
    if isinstance(diff, dict):
        diff = list(diff.values())
    rows = []
    for it in diff:
        try:
            rows.append({
                "code": it.get("f12"), "name": it.get("f14"),
                "pct": it.get("f3"), "main_yi": round((it.get("f62") or 0)/1e8, 2),
                "main_ratio": it.get("f184"),
                "xl_yi": round((it.get("f66") or 0)/1e8, 2),   # 超大单
                "lg_yi": round((it.get("f72") or 0)/1e8, 2),   # 大单
                "md_yi": round((it.get("f78") or 0)/1e8, 2),   # 中单
                "sm_yi": round((it.get("f84") or 0)/1e8, 2),   # 小单
            })
        except Exception:
            continue
    print(f"### {fs_name} count={len(rows)}", file=sys.stderr)
    return rows

ind = board_flow("industry", "m:90+t:2+f:!50", 200)
con = board_flow("concept", "m:90+t:3+f:!50", 500)
out = {"industry": ind, "concept": con,
       "industry_main_sum_yi": round(sum(x["main_yi"] for x in ind), 1)}
with open("sector_flow.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
print("saved", len(ind), len(con))
