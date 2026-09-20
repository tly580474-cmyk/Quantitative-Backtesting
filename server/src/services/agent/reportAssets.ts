import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Marked } from 'marked';

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
  if (paths.size > 12) throw new Error('报告最多包含12张图');
  const result = new Map<string, string>();
  if (!paths.size) return result;
  const root = await realpath(workspace);
  const task = await realpath(taskArtifactDirectory(workspace, runId));
  if (!inside(root, task)) throw new Error('任务图片目录越界');
  let total = 0;
  for (const href of paths) {
    const path = await realpath(resolve(workspace, href));
    if (!inside(task, path)) throw new Error('图片不在当前任务目录内');
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('图片大小超过2MB或不是文件');
    const bytes = await readFile(path);
    total += bytes.length;
    if (total > 6 * 1024 * 1024) throw new Error('图片总大小超过6MB');
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : null;
    if (!mime) throw new Error('仅支持PNG/JPEG任务图片');
    result.set(href, `data:${mime};base64,${bytes.toString('base64')}`);
  }
  return result;
}
