import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Marked } from 'marked';

/** User-facing asset failures; filesystem and other internal errors stay private. */
export class ReportAssetError extends Error {}

export function taskArtifactDirectory(workspace: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid task id');
  return resolve(workspace, 'tmp_output', 'agent-runs', runId);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Only raster images in this run's real directory become self-contained report assets. */
export async function collectReportAssets(content: string, workspace: string, runId: string): Promise<Map<string, string>> {
  const paths = new Set<string>();
  const parser = new Marked({ walkTokens(token) {
    if (token.type === 'image' && (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(token.href) || /^[a-z]:[\\/]/i.test(token.href))) paths.add(token.href);
  } });
  parser.parse(content);
  if (paths.size > 12) throw new ReportAssetError(`报告引用了${paths.size}张图，最多允许12张；请合并或删减图表后重试`);
  const result = new Map<string, string>();
  if (!paths.size) return result;
  const root = await realpath(workspace);
  const task = await realpath(taskArtifactDirectory(workspace, runId));
  const expectedTask = taskArtifactDirectory(root, runId);
  if (!inside(root, task) || relative(expectedTask, task) !== '') throw new ReportAssetError('任务图片目录越界');
  let total = 0;
  for (const href of paths) {
    const requested = resolve(workspace, href);
    if (!inside(taskArtifactDirectory(workspace, runId), requested)) throw new ReportAssetError('图片不在当前任务目录内');
    const path = await realpath(requested);
    if (!inside(task, path)) throw new ReportAssetError('图片不在当前任务目录内');
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ReportAssetError('图片大小超过2MB或不是文件');
    const bytes = await readFile(path);
    total += bytes.length;
    if (total > 6 * 1024 * 1024) throw new ReportAssetError('图片总大小超过6MB');
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
    if (!mime) throw new ReportAssetError('仅支持PNG/JPEG任务图片');
    result.set(href, `data:${mime};base64,${bytes.toString('base64')}`);
  }
  return result;
}
