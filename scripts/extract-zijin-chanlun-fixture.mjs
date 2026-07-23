import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'output', 'zijin-mining-chanlun-daily.html');
const fixturePath = resolve(
  root,
  'src',
  'features',
  'chanlun',
  '__tests__',
  'fixtures',
  'zijin-601899-daily-500.json',
);
const html = await readFile(sourcePath, 'utf8');
const match = html.match(/const raw=(\[[\s\S]*?\]);\s*function included/);
if (!match) throw new Error(`Cannot find embedded bars in ${sourcePath}`);
const raw = JSON.parse(match[1]);
const candles = raw.map((bar) => ({
  time: bar.d,
  symbol: '601899.SH',
  open: bar.o,
  high: bar.h,
  low: bar.l,
  close: bar.c,
  volume: bar.v,
  turnover: bar.a,
}));
if (candles.length !== 500) throw new Error(`Expected 500 bars, got ${candles.length}`);
await mkdir(dirname(fixturePath), { recursive: true });
await writeFile(fixturePath, `${JSON.stringify(candles, null, 2)}\n`, 'utf8');
console.log(`Wrote ${candles.length} offline bars to ${fixturePath}`);
