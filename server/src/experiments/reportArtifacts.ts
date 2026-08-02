import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';

const WINDOWS_BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

export interface ReportArtifactRendererOptions {
  artifactRoot: string;
  chromiumExecutable?: string;
  timeoutMs: number;
}

export async function buildReportHtml(markdown: string): Promise<string> {
  const body = await marked.parse(markdown);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>实验报告</title>
  <style>
    @page { size: A4; margin: 16mm 14mm; }
    :root { color-scheme: light; font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #172033; }
    body { max-width: 900px; margin: 0 auto; font-size: 13px; line-height: 1.65; }
    h1 { font-size: 24px; border-bottom: 2px solid #1677ff; padding-bottom: 10px; }
    h2 { font-size: 18px; margin-top: 24px; }
    table { width: 100%; border-collapse: collapse; break-inside: auto; }
    tr { break-inside: avoid; }
    th, td { border: 1px solid #d9e2ef; padding: 7px 8px; text-align: left; vertical-align: top; }
    th { background: #f2f6fc; }
    code { overflow-wrap: anywhere; color: #0f4c9b; }
    blockquote { margin: 20px 0 0; padding: 10px 14px; background: #f7f9fc; border-left: 4px solid #8bb8ff; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(() => true).catch(() => false);
}

export async function resolveChromiumExecutable(explicit?: string): Promise<string> {
  if (explicit) {
    const absolute = resolve(explicit);
    if (await isExecutable(absolute)) return absolute;
    throw new Error(`PDF_CHROMIUM_NOT_FOUND: ${absolute}`);
  }
  const candidates = process.platform === 'win32'
    ? WINDOWS_BROWSER_CANDIDATES
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error('PDF_CHROMIUM_NOT_FOUND: configure EXPERIMENT_REPORT_CHROMIUM_EXECUTABLE');
}

function runBrowser(executable: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PDF_RENDER_TIMEOUT: exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 2000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`PDF_RENDER_FAILED: browser exited ${code}; ${stderr.slice(-1000)}`));
    });
  });
}

export async function renderReportArtifact(
  markdown: string,
  cacheKey: string,
  format: 'html' | 'pdf',
  options: ReportArtifactRendererOptions,
): Promise<string> {
  await mkdir(options.artifactRoot, { recursive: true });
  const html = await buildReportHtml(markdown);
  const htmlPath = resolve(options.artifactRoot, `${cacheKey}.html`);
  if (format === 'html') {
    await writeFile(htmlPath, html, 'utf8');
    return htmlPath;
  }

  const pdfPath = resolve(options.artifactRoot, `${cacheKey}.pdf`);
  const profilePath = resolve(tmpdir(), `experiment-report-${cacheKey.slice(0, 12)}-${process.pid}`);
  await writeFile(htmlPath, html, 'utf8');
  const browser = await resolveChromiumExecutable(options.chromiumExecutable);
  try {
    await runBrowser(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=1',
      `--user-data-dir=${profilePath}`, `--print-to-pdf=${pdfPath}`,
      '--print-to-pdf-no-header', pathToFileURL(htmlPath).href,
    ], options.timeoutMs);
    const result = await stat(pdfPath);
    if (result.size < 1000) throw new Error(`PDF_RENDER_EMPTY: ${result.size} bytes`);
    return pdfPath;
  } finally {
    await rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(htmlPath, { force: true }).catch(() => undefined);
  }
}

export async function readArtifact(path: string): Promise<Buffer> {
  return readFile(path);
}

export const REPORT_ARTIFACT_GENERATOR_VERSION = 'experiment-report-chromium-1.0.0';

export async function describeReportArtifact(path: string, format: 'html' | 'pdf') {
  const content = await readFile(path);
  return {
    mimeType: format === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8',
    byteSize: content.byteLength,
    checksum: createHash('sha256').update(content).digest('hex'),
    generatorVersion: REPORT_ARTIFACT_GENERATOR_VERSION,
  };
}

export function isArtifactPathInsideRoot(path: string, root: string): boolean {
  const target = resolve(path);
  const base = `${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`;
  return target.startsWith(base) && dirname(target).startsWith(resolve(root));
}
