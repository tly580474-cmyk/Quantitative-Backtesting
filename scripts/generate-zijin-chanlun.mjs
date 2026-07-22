import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, '..', 'output', 'zijin-mining-chanlun-daily.html');
const endpoint = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
endpoint.search = new URLSearchParams({
  secid: '1.601899',
  klt: '101',
  fqt: '1',
  lmt: '500',
  end: '20500101',
  fields1: 'f1,f2,f3,f4,f5,f6',
  fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
}).toString();

const response = await fetch(endpoint, {
  headers: {
    Referer: 'https://quote.eastmoney.com/sh601899.html',
    'User-Agent': 'Mozilla/5.0',
  },
});
if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`);
const payload = await response.json();
if (!payload?.data?.klines?.length) throw new Error('Eastmoney did not return daily bars');

const bars = payload.data.klines.map((line, index) => {
  const parts = line.split(',');
  return {
    i: index,
    d: parts[0],
    o: Number(parts[1]),
    c: Number(parts[2]),
    h: Number(parts[3]),
    l: Number(parts[4]),
    v: Number(parts[5]),
    a: Number(parts[6]),
  };
});

const generatedAt = new Date().toISOString();
const dataJson = JSON.stringify(bars);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>紫金矿业日K缠论线测试</title>
<style>
:root{color-scheme:dark;--bg:#0c111b;--panel:#121a27;--line:#263247;--text:#e8edf5;--muted:#94a3b8;--up:#ef5350;--down:#26a69a;--pen:#f6c85f;--candidate:#ff8a65;--fractal:#7aa2f7;--center:#b388ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1680px;margin:auto;padding:22px}.head{display:flex;gap:18px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px}h1{font-size:22px;margin:0;font-weight:650}.sub{color:var(--muted);margin-top:4px}.controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.controls label{display:flex;align-items:center;gap:6px;color:var(--muted)}select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 10px}.stats{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px;margin:12px 0}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.stat b{display:block;font-size:18px}.stat span{color:var(--muted);font-size:12px}.chart-wrap{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}canvas{display:block;width:100%;height:720px}.tip{display:none;position:absolute;pointer-events:none;background:#111827ee;border:1px solid #40506b;border-radius:7px;padding:8px 10px;white-space:nowrap;font-size:12px;z-index:3}.legend{display:flex;gap:17px;flex-wrap:wrap;color:var(--muted);margin:10px 2px}.key{display:inline-flex;align-items:center;gap:6px}.sw{width:18px;height:3px;background:currentColor;border-radius:2px}.note{color:var(--muted);font-size:12px;border-left:3px solid var(--line);padding-left:10px;margin-top:12px}code{color:var(--text)}
@media(max-width:760px){main{padding:12px}.stats{grid-template-columns:repeat(2,1fr)}canvas{height:600px}}
</style>
</head>
<body>
<main>
  <div class="head">
    <div><h1>紫金矿业 <small>601899.SH · 日K</small></h1><div class="sub">前复权 · 东方财富行情 · ${bars[0].d}—${bars.at(-1).d}</div></div>
    <div class="controls">
      <label>显示范围 <select id="range"><option value="60">最近60日</option><option value="120" selected>最近120日</option><option value="250">最近250日</option><option value="500">全部500日</option></select></label>
      <label><input id="fractals" type="checkbox" checked> 分型</label>
      <label><input id="pens" type="checkbox" checked> 笔</label>
      <label><input id="centers" type="checkbox" checked> 测试中枢</label>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><b id="lastClose">—</b><span>最新收盘</span></div>
    <div class="stat"><b id="rawCount">—</b><span>原始日K</span></div>
    <div class="stat"><b id="mergedCount">—</b><span>去包含K线</span></div>
    <div class="stat"><b id="fractalCount">—</b><span>有效分型候选</span></div>
    <div class="stat"><b id="penCount">—</b><span>缠论笔</span></div>
  </div>
  <div class="chart-wrap" id="wrap"><canvas id="chart" role="img" aria-label="紫金矿业日K、成交量、缠论分型、笔和测试中枢图"></canvas><div class="tip" id="tip"></div></div>
  <div class="legend">
    <span class="key" style="color:var(--up)"><i class="sw"></i>上涨K线</span>
    <span class="key" style="color:var(--down)"><i class="sw"></i>下跌K线</span>
    <span class="key" style="color:var(--pen)"><i class="sw"></i>已确认笔</span>
    <span class="key" style="color:var(--candidate)"><i class="sw"></i>最后候选笔</span>
    <span class="key" style="color:var(--center)"><i class="sw"></i>三笔重叠测试中枢</span>
  </div>
  <div class="note">规则口径：相邻K线按趋势方向去包含；严格顶底分型；采用“新笔”间距条件（两端极值原始K线之间至少3根原始K线）。最后一笔会随未来行情延伸，使用虚线标示。中枢层仅用于本次最低级别测试，按连续三笔价格区间重叠计算，不等同于完整递归走势中枢。数据生成时间：${generatedAt}。</div>
</main>
<script>
const raw=${dataJson};
function included(a,b){return (a.h>=b.h&&a.l<=b.l)||(b.h>=a.h&&b.l<=a.l)}
function mergeBars(input){
  const out=[];let direction=1;
  input.forEach((bar)=>{
    if(!out.length){out.push({...bar,s:bar.i,e:bar.i,hi:bar.i,li:bar.i});return}
    const last=out[out.length-1];
    if(!included(last,bar)){
      if(bar.h>last.h&&bar.l>last.l)direction=1;
      else if(bar.h<last.h&&bar.l<last.l)direction=-1;
      out.push({...bar,s:bar.i,e:bar.i,hi:bar.i,li:bar.i});return;
    }
    if(direction>0){
      const takeHigh=bar.h>last.h,takeLow=bar.l>last.l;
      last.h=Math.max(last.h,bar.h);last.l=Math.max(last.l,bar.l);
      if(takeHigh)last.hi=bar.i;if(takeLow)last.li=bar.i;
    }else{
      const takeHigh=bar.h<last.h,takeLow=bar.l<last.l;
      last.h=Math.min(last.h,bar.h);last.l=Math.min(last.l,bar.l);
      if(takeHigh)last.hi=bar.i;if(takeLow)last.li=bar.i;
    }
    last.c=bar.c;last.e=bar.i;last.d=bar.d;last.v+=bar.v;last.a+=bar.a;
  });return out;
}
function findFractals(m){
  const f=[];
  for(let i=1;i<m.length-1;i++){
    const a=m[i-1],b=m[i],c=m[i+1];
    if(b.h>a.h&&b.h>c.h&&b.l>a.l&&b.l>c.l)f.push({t:'top',mi:i,ri:b.hi,p:b.h,d:raw[b.hi].d});
    if(b.l<a.l&&b.l<c.l&&b.h<a.h&&b.h<c.h)f.push({t:'bottom',mi:i,ri:b.li,p:b.l,d:raw[b.li].d});
  }return f;
}
function isMoreExtreme(a,b){return a.t==='top'?a.p>b.p:a.p<b.p}
function findPens(fractals){
  const pivots=[];
  for(const f of fractals){
    if(!pivots.length){pivots.push({...f});continue}
    const last=pivots[pivots.length-1];
    if(f.t===last.t){if(isMoreExtreme(f,last))pivots[pivots.length-1]={...f};continue}
    const spacing=Math.abs(f.ri-last.ri)-1>=3;
    const validPrice=last.t==='bottom'?f.p>last.p:f.p<last.p;
    if(spacing&&validPrice)pivots.push({...f});
  }
  return pivots;
}
function findCenters(p){
  const seg=[];for(let i=0;i<p.length-1;i++)seg.push({s:p[i].ri,e:p[i+1].ri,lo:Math.min(p[i].p,p[i+1].p),hi:Math.max(p[i].p,p[i+1].p)});
  const centers=[];let i=0;
  while(i<=seg.length-3){
    let lo=Math.max(seg[i].lo,seg[i+1].lo,seg[i+2].lo),hi=Math.min(seg[i].hi,seg[i+1].hi,seg[i+2].hi);
    if(lo<=hi){let j=i+2;while(j+1<seg.length&&seg[j+1].hi>=lo&&seg[j+1].lo<=hi)j++;centers.push({s:seg[i].s,e:seg[j].e,lo,hi});i=j+1}else i++;
  }return centers;
}
const merged=mergeBars(raw),fractals=findFractals(merged),pivots=findPens(fractals),centers=findCenters(pivots);
document.getElementById('lastClose').textContent=raw.at(-1).c.toFixed(2);
document.getElementById('rawCount').textContent=raw.length;
document.getElementById('mergedCount').textContent=merged.length;
document.getElementById('fractalCount').textContent=fractals.length;
document.getElementById('penCount').textContent=Math.max(0,pivots.length-1);
const canvas=document.getElementById('chart'),wrap=document.getElementById('wrap'),tip=document.getElementById('tip');let hit=[];
function draw(){
  const dpr=Math.max(1,window.devicePixelRatio||1),w=canvas.clientWidth,h=canvas.clientHeight;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);
  const n=Number(document.getElementById('range').value),start=Math.max(0,raw.length-n),vis=raw.slice(start),left=54,right=62,top=22,priceBottom=h*0.76,volTop=h*0.80,bottom=h-34,plotW=w-left-right;
  const maxP=Math.max(...vis.map(x=>x.h)),minP=Math.min(...vis.map(x=>x.l)),pad=(maxP-minP)*.06||1,yMax=maxP+pad,yMin=minP-pad,maxV=Math.max(...vis.map(x=>x.v));
  const x=i=>left+((i-start)+.5)*plotW/vis.length,y=p=>top+(yMax-p)*(priceBottom-top)/(yMax-yMin),yv=v=>bottom-v*(bottom-volTop)/maxV;
  c.font='12px system-ui';c.textBaseline='middle';c.strokeStyle='#263247';c.fillStyle='#94a3b8';c.lineWidth=1;
  for(let k=0;k<=5;k++){const py=top+k*(priceBottom-top)/5,pv=yMax-k*(yMax-yMin)/5;c.beginPath();c.moveTo(left,py);c.lineTo(w-right,py);c.stroke();c.fillText(pv.toFixed(2),w-right+7,py)}
  const tick=Math.max(1,Math.ceil(vis.length/8));for(let j=0;j<vis.length;j+=tick){const px=x(start+j);c.fillText(vis[j].d.slice(5),px-16,h-15)}
  if(document.getElementById('centers').checked){centers.filter(z=>z.e>=start).forEach(z=>{const xs=x(Math.max(z.s,start)),xe=x(Math.min(z.e,raw.length-1));c.fillStyle='#b388ff20';c.strokeStyle='#b388ff99';c.fillRect(xs,y(z.hi),Math.max(2,xe-xs),y(z.lo)-y(z.hi));c.strokeRect(xs,y(z.hi),Math.max(2,xe-xs),y(z.lo)-y(z.hi))})}
  const cw=Math.max(1,Math.min(10,plotW/vis.length*.68));hit=[];
  vis.forEach((b,j)=>{const idx=start+j,px=x(idx),up=b.c>=b.o,col=up?'#ef5350':'#26a69a';c.strokeStyle=col;c.fillStyle=col;c.beginPath();c.moveTo(px,y(b.h));c.lineTo(px,y(b.l));c.stroke();const yo=y(Math.max(b.o,b.c)),yc=y(Math.min(b.o,b.c));c.fillRect(px-cw/2,yo,cw,Math.max(1,yc-yo));c.globalAlpha=.42;c.fillRect(px-cw/2,yv(b.v),cw,bottom-yv(b.v));c.globalAlpha=1;hit.push({x:px,b})});
  if(document.getElementById('fractals').checked){fractals.filter(f=>f.ri>=start).forEach(f=>{const px=x(f.ri),py=y(f.p),s=5;c.fillStyle='#7aa2f7';c.beginPath();if(f.t==='top'){c.moveTo(px,py-8);c.lineTo(px-s,py-8-s);c.lineTo(px+s,py-8-s)}else{c.moveTo(px,py+8);c.lineTo(px-s,py+8+s);c.lineTo(px+s,py+8+s)}c.closePath();c.fill()})}
  if(document.getElementById('pens').checked&&pivots.length>1){c.lineWidth=2.2;c.lineJoin='round';for(let i=0;i<pivots.length-1;i++){const a=pivots[i],b=pivots[i+1];if(b.ri<start)continue;c.strokeStyle=i===pivots.length-2?'#ff8a65':'#f6c85f';c.setLineDash(i===pivots.length-2?[7,5]:[]);c.beginPath();c.moveTo(x(a.ri),y(a.p));c.lineTo(x(b.ri),y(b.p));c.stroke()}c.setLineDash([])}
 }
function showTip(ev){if(!hit.length)return;const r=canvas.getBoundingClientRect(),mx=ev.clientX-r.left;let q=hit.reduce((a,b)=>Math.abs(b.x-mx)<Math.abs(a.x-mx)?b:a);const b=q.b;tip.innerHTML='<b>'+b.d+'</b><br>开 '+b.o.toFixed(2)+'　高 '+b.h.toFixed(2)+'<br>低 '+b.l.toFixed(2)+'　收 '+b.c.toFixed(2)+'<br>量 '+(b.v/10000).toFixed(0)+' 万手';tip.style.display='block';let tx=Math.min(wrap.clientWidth-155,Math.max(8,q.x+12));tip.style.left=tx+'px';tip.style.top='44px'}
canvas.addEventListener('mousemove',showTip);canvas.addEventListener('mouseleave',()=>tip.style.display='none');
['range','fractals','pens','centers'].forEach(id=>document.getElementById(id).addEventListener('change',draw));new ResizeObserver(draw).observe(wrap);draw();
</script>
</body>
</html>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, 'utf8');
console.log(JSON.stringify({ outputPath, bars: bars.length, firstDate: bars[0].d, lastDate: bars.at(-1).d }));
