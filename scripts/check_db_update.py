import pymysql, json
from datetime import datetime, timedelta

DB = dict(host='127.0.0.1', port=3306, user='user1', password='123456',
          database='quant_backtest', charset='utf8mb4')
TODAY = '2026-07-17'

conn = pymysql.connect(**DB)
cur = conn.cursor()

def q(sql, args=None):
    cur.execute(sql, args or ())
    return cur.fetchall()

def s(v):
    if v is None: return ''
    if isinstance(v, (datetime,)): return v.strftime('%Y-%m-%d %H:%M:%S')
    return str(v)

# ---------- 今日数据导入批次 ----------
today_batches = q(f"""
    SELECT id, source_root, source_snapshot, status, total_files, completed_files,
           failed_files, total_rows, imported_rows, started_at, finished_at, published_at
    FROM data_import_batches
    WHERE DATE(started_at)='{TODAY}' OR DATE(finished_at)='{TODAY}' OR DATE(published_at)='{TODAY}'
    ORDER BY COALESCE(published_at, finished_at, started_at) DESC
""")
recent_batches = q("""
    SELECT id, source_root, source_snapshot, status, total_files, completed_files,
           failed_files, total_rows, imported_rows, started_at, finished_at, published_at
    FROM data_import_batches ORDER BY COALESCE(started_at, published_at) DESC LIMIT 10
""")

# 今日批次的文件明细
today_batch_ids = [r[0] for r in today_batches]
today_files = []
if today_batch_ids:
    ph = ','.join(['%s'] * len(today_batch_ids))
    today_files = q(f"""
        SELECT batch_id, relative_path, adjustment_mode, min_date, max_date,
               status, imported_rows, expected_rows, error_message
        FROM data_import_files WHERE batch_id IN ({ph})
        ORDER BY batch_id, relative_path
    """, today_batch_ids)

# ---------- 行情表最新状态 ----------
max_daily = q("SELECT MAX(trade_date) FROM daily_bars_v2")[0][0]
today_daily_rows = q(f"SELECT COUNT(*) FROM daily_bars_v2 WHERE trade_date='{TODAY}'")[0][0]
today_daily_inst = q(f"SELECT COUNT(DISTINCT instrument_key) FROM daily_bars_v2 WHERE trade_date='{TODAY}'")[0][0]
md = max_daily if isinstance(max_daily, str) else max_daily.strftime('%Y-%m-%d')
thr = (datetime.strptime(md, '%Y-%m-%d') - timedelta(days=20)).strftime('%Y-%m-%d')
daily_recent = [{'date': str(r[0]), 'rows': r[1]} for r in
                q(f"SELECT trade_date, COUNT(*) FROM daily_bars_v2 WHERE trade_date>='{thr}' GROUP BY trade_date ORDER BY trade_date")]

max_candle = q("SELECT MAX(time) FROM candles")[0][0]
today_candle_rows = q(f"SELECT COUNT(*) FROM candles WHERE time='{TODAY}'")[0][0]
candle_today = [{'symbol': r[0], 'close': r[1], 'chg_pct': r[2], 'volume': r[3]}
                for r in q(f"SELECT symbol, close, change_percent, volume FROM candles WHERE time='{TODAY}'")]
mc = max_candle if isinstance(max_candle, str) else max_candle.strftime('%Y-%m-%d')
cthr = (datetime.strptime(mc, '%Y-%m-%d') - timedelta(days=20)).strftime('%Y-%m-%d')
candle_recent = [{'date': str(r[0]), 'rows': r[1]} for r in
                 q(f"SELECT time, COUNT(*) FROM candles WHERE time>='{cthr}' GROUP BY time ORDER BY time")]

# ---------- 同步任务 ----------
today_sync = q(f"""
    SELECT id, job_type, status, provider_id, total_items, completed_items, failed_items, created_at, started_at, finished_at
    FROM sync_jobs WHERE DATE(created_at)='{TODAY}' OR DATE(started_at)='{TODAY}' OR DATE(finished_at)='{TODAY}'
    ORDER BY created_at DESC
""")
recent_sync = q("SELECT id, job_type, status, provider_id, created_at, finished_at FROM sync_jobs ORDER BY created_at DESC LIMIT 10")

# ---------- 今日数据质量告警 ----------
today_quality = q(f"SELECT COUNT(*) FROM data_quality_issues WHERE DATE(detected_at)='{TODAY}'")[0][0]
quality_break = q(f"""
    SELECT severity, COUNT(*) FROM data_quality_issues WHERE DATE(detected_at)='{TODAY}' GROUP BY severity
""")

# ---------- instruments ----------
inst_total = q("SELECT COUNT(*) FROM instruments")[0][0]
inst_active = q("SELECT COUNT(*) FROM instruments WHERE status='active'")[0][0]

cur.close(); conn.close()

result = {
    'query_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'today': TODAY,
    'today_batches': [{'id': r[0], 'source_root': r[1], 'snapshot': r[2], 'status': r[3],
                       'total_files': r[4], 'completed': r[5], 'failed': r[6],
                       'total_rows': r[7], 'imported': r[8], 'started': s(r[9]),
                       'finished': s(r[10]), 'published': s(r[11])} for r in today_batches],
    'recent_batches': [{'id': r[0], 'snapshot': r[2], 'status': r[3], 'total_files': r[4],
                        'completed': r[5], 'failed': r[6], 'imported': r[8], 'started': s(r[9]),
                        'published': s(r[11])} for r in recent_batches],
    'today_files': [{'batch': r[0], 'path': r[1], 'adj': r[2], 'min': s(r[3]), 'max': s(r[4]),
                     'status': r[5], 'imported': r[6], 'expected': r[7], 'err': r[8]} for r in today_files],
    'daily_bars': {'latest': md, 'today_rows': today_daily_rows, 'today_inst': today_daily_inst, 'recent': daily_recent},
    'candles': {'latest': mc, 'today_rows': today_candle_rows, 'today_list': candle_today, 'recent': candle_recent},
    'today_sync': [{'id': r[0], 'type': r[1], 'status': r[2], 'provider': r[3], 'total': r[4],
                    'completed': r[5], 'failed': r[6], 'created': r[7], 'started': r[8], 'finished': r[9]}
                   for r in today_sync],
    'recent_sync': [{'id': r[0], 'type': r[1], 'status': r[2], 'provider': r[3], 'created': r[4], 'finished': r[5]}
                    for r in recent_sync],
    'quality_today': today_quality, 'quality_break': [{'sev': r[0], 'n': r[1]} for r in quality_break],
    'instruments': {'total': inst_total, 'active': inst_active},
}
with open(r'D:\github_public_repo\量化回测\outputs\db_update_raw.json', 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

# ---------- 生成 HTML 报告 ----------
has_import = len(result['today_batches']) > 0
has_sync = len(result['today_sync']) > 0
latest = md  # daily_bars 为主
conclusion = []
if has_import:
    conclusion.append(f"✅ 今日（{TODAY}）有 <b>{len(result['today_batches'])}</b> 个数据导入批次完成/进行中。")
else:
    conclusion.append(f"⚪ 今日（{TODAY}）未发现新的数据导入批次（data_import_batches）。")
if has_sync:
    conclusion.append(f"🔄 今日有 <b>{len(result['today_sync'])}</b> 个同步任务（sync_jobs）。")
else:
    conclusion.append("🔄 今日未发现新的同步任务。")
conclusion.append(f"📈 个股日线（daily_bars_v2）最新交易日：<b>{md}</b>；今日记录数：{today_daily_rows}，覆盖标的 {today_daily_inst} 只。")
conclusion.append(f"📊 指数日线（candles）最新交易日：<b>{mc}</b>（今日记录数：{today_candle_rows}）。")
if today_quality:
    conclusion.append(f"⚠️ 今日新增数据质量告警 <b>{today_quality}</b> 条。")
else:
    conclusion.append("✅ 今日无新增数据质量告警。")
failed_sync = [s for s in result['today_sync'] if s['status'] == 'failed']
if failed_sync:
    conclusion.append(f"⚠️ <b>异常：</b>cn-index 指数同步任务（runKey <b>cn-index:2026-07-17</b>）今日重试 <b>{len(failed_sync)}</b> 次，每次失败 1 项；结合 candles 实际缺失情况，失败项为 <b>932000（中证2000）</b>。其余 8 个 A 股指数已成功更新。")

# 今日缺失的指数（对比预期 cn-index 清单）
expected_cn_index = {'000001','000300','000680','000688','000852','000905','932000','399001','399006'}
actual_cn = {r['symbol'] for r in candle_today}
missing_cn = sorted(expected_cn_index - actual_cn)
if missing_cn:
    conclusion.append(f"📉 candles 今日缺失 A 股指数：{', '.join(missing_cn)}。")
# NDX 非 cn-index 组，独立数据源


def tbl(headers, rows, status_col=None):
    h = ''.join(f'<th>{"</th><th>".join(headers)}</th>')
    body = ''
    for row in rows:
        tds = ''
        for ci, c in enumerate(row):
            if status_col is not None and ci == status_col:
                cls = 'tag-ok' if str(c) in ('completed', 'ok') else ('tag-fail' if str(c) in ('failed', 'error') else 'tag-run')
                tds += f'<td class="{cls}">{c}</td>'
            else:
                tds += f'<td>{c}</td>'
        body += f'<tr>{tds}</tr>'
    return f'<table><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table>'

html = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>量化回测数据库 · 今日更新情况</title>
<style>
 body{{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;margin:32px;color:#1f2329;background:#f7f8fa;}}
 h1{{font-size:22px;border-left:4px solid #2f6fed;padding-left:10px;}}
 h2{{font-size:16px;margin-top:28px;color:#2f6fed;}}
 .meta{{color:#6b7280;font-size:13px;}}
 .summary{{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin:16px 0;line-height:1.9;}}
 .summary b{{color:#111827;}}
 table{{border-collapse:collapse;width:100%;background:#fff;font-size:13px;margin-top:8px;}}
 th,td{{border:1px solid #e5e7eb;padding:7px 10px;text-align:left;}}
 th{{background:#f0f3f9;font-weight:600;}}
 tr:nth-child(even) td{{background:#fafbfc;}}
 .tag-ok{{color:#0a7d33;font-weight:600;}}
 .tag-fail{{color:#c0392b;font-weight:600;}}
 .tag-run{{color:#b7791f;font-weight:600;}}
</style></head><body>
<h1>量化回测数据库 · 今日更新情况</h1>
<p class="meta">报告生成时间：{result['query_time']} ｜ 查询基准日：{TODAY} ｜ 数据库：quant_backtest</p>
<div class="summary">{''.join('<div>'+c+'</div>' for c in conclusion)}</div>
"""

# 一、今日导入批次
html += '<h2>一、今日数据导入批次（data_import_batches）</h2>'
if result['today_batches']:
    rows = [[b['id'][:8], b['snapshot'], b['status'], b['total_files'], b['completed'],
             b['failed'], f"{b['imported']:,}", b['started'], b['published']] for b in result['today_batches']]
    html += tbl(['批次ID', '快照', '状态', '文件数', '完成', '失败', '导入行数', '开始', '发布'], rows)
else:
    html += '<p class="meta">今日无数据导入批次。</p>'

# 二、今日导入文件明细
html += '<h2>二、今日导入文件明细（data_import_files）</h2>'
if result['today_files']:
    rows = [[f['batch'][:8], f['path'], f['adj'], f['min'], f['max'], f['status'],
             f"{f['imported']:,}", f"{f['expected']:,}", (f['err'] or '')[:40]] for f in result['today_files']]
    html += tbl(['批次', '相对路径', '复权', '最小日期', '最大日期', '状态', '导入行', '预期行', '错误'], rows)
else:
    html += '<p class="meta">今日无导入文件明细。</p>'

# 三、行情最新状态
html += '<h2>三、行情数据最新状态</h2>'
html += f'<p class="meta">个股日线 daily_bars_v2 最新交易日 <b>{md}</b>，近 20 天每日记录数：</p>'
html += tbl(['交易日', '记录数'], [[r['date'], f"{r['rows']:,}"] for r in daily_recent])
html += f'<p class="meta">指数日线 candles 最新交易日 <b>{mc}</b>，近 20 天每日记录数：</p>'
html += tbl(['交易日', '记录数'], [[r['date'], f"{r['rows']:,}"] for r in candle_recent])
html += f'<p class="meta">2026-07-17 实际有 {today_candle_rows} 条指数记录，缺失 A 股指数：{', '.join(missing_cn) or '无'}。NDX 不属 cn-index 组，数据源独立，今日亦缺失。</p>'

# 四、同步任务
html += '<h2>四、同步任务（sync_jobs）</h2>'
if result['today_sync']:
    rows = [[s['id'][:8], s['type'], s['status'], s['provider'], s['total'], s['completed'],
             s['failed'], s['created'], s['finished']] for s in result['today_sync']]
    html += tbl(['任务ID', '类型', '状态', '提供方', '总数', '完成', '失败', '创建', '结束'], rows, status_col=2)
    html += '<p class="meta">说明：以上 8 个 dataset-index-incremental 任务为同一 runKey「cn-index:2026-07-17」的连续重试；每次 total=9，completed=8，failed=1。失败项经 candles 缺失比对为 932000（中证2000）。</p>'
else:
    html += '<p class="meta">今日无新的同步任务。</p>'

# 五、数据质量
html += '<h2>五、数据质量告警（今日新增）</h2>'
if result['quality_today']:
    rows = [[b['sev'], b['n']] for b in result['quality_break']]
    html += tbl(['严重级别', '数量'], rows)
else:
    html += '<p class="meta">今日无新增数据质量告警。</p>'

# 六、标的基础信息
html += '<h2>六、标的基础信息（instruments）</h2>'
html += tbl(['指标', '数值'], [['标的总数', f"{inst_total:,}"], ['存续(active)标的数', f"{inst_active:,}"]])

html += '</body></html>'

with open(r'D:\github_public_repo\量化回测\outputs\db_update_report.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("REPORT_WRITTEN")
print(json.dumps({'today_batches': len(result['today_batches']),
                  'today_sync': len(result['today_sync']),
                  'latest_daily': md, 'latest_candle': mc,
                  'today_daily_rows': today_daily_rows, 'today_quality': today_quality},
                 ensure_ascii=False))
