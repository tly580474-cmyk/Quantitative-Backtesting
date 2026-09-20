import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fingerprint } from './sourceMemory.js';

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
async function safePath(workspace: string, file: string, create: boolean) {
  const root = resolve(workspace, 'tmp_output', 'agent-runs');
  const path = resolve(workspace, file);
  if (!within(root, path) || !path.endsWith('.json')) throw new Error('INVALID_ARGUMENT: 产物须位于 tmp_output/agent-runs 下且为JSON');
  if (create) {
    const workspaceRoot = await realpath(workspace);
    let current = workspaceRoot;
    for (const part of relative(resolve(workspace), dirname(path)).split(sep)) {
      current = resolve(current, part);
      try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      current = await realpath(current);
      if (!within(workspaceRoot, current)) throw new Error('INVALID_ARGUMENT: 产物目录越界');
    }
  }
  const realRoot = await realpath(root);
  if (!within(await realpath(workspace), realRoot) || !within(realRoot, resolve(await realpath(dirname(path)), 'placeholder'))) throw new Error('INVALID_ARGUMENT: 产物目录越界');
  if (!create && !within(realRoot, await realpath(path))) throw new Error('INVALID_ARGUMENT: 产物路径越界');
  return path;
}
export async function saveCapsule(workspace: string, file: string, result: Record<string, unknown>,
  context: { argv: string[]; snapshotPointer: string; inputHashes: string[] }, now = Date.now()) {
  const snapshotBound = typeof result.snapshotId === 'string' && typeof result.manifestPath === 'string';
  // Only built-in snapshot-only recipes have a known complete dependency set.
  // Ad hoc SQL can read mutable files or use current_date even when a snapshot is registered.
  const immutableRecipe = snapshotBound && context.argv[0] === 'recipe' && ['candidate-screen', 'factor-layer-14'].includes(context.argv[1]);
  const payload = { version: 1, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + (immutableRecipe ? 86_400_000 : 30_000)).toISOString(),
    ...context, result, validation: { state: result.ok === true && result.usable === true ? 'data-returned' : 'not-proven-usable',
      snapshotBinding: snapshotBound ? 'query-manifest' : 'observed-pointer-not-query-lock',
      semantics: '保留入口原始口径、缺失项和sample/truncated；不等于研究结论已审计。大结果使用DuckDB导出及其manifest。',
      assumptions: '不得从工具成功推断覆盖完整、无未来信息或用户假设已验证。' } };
  const path = await safePath(workspace, file, true);
  await writeFile(path, JSON.stringify({ ...payload, sha256: fingerprint(payload) }, null, 2), { flag: 'wx', mode: 0o600 });
  return { path: relative(workspace, path).split(sep).join('/'), sha256: fingerprint(payload), expiresAt: payload.expiresAt };
}
export async function reuseCapsule(workspace: string, file: string, pointer: string, now = Date.now()) {
  const capsule = JSON.parse(await readFile(await safePath(workspace, file, false), 'utf8'));
  const { sha256, ...payload } = capsule;
  const reasons: string[] = [];
  if (payload.version !== 1 || sha256 !== fingerprint(payload)) reasons.push('integrity-mismatch');
  if (reasons.length) return { kind: 'research-capsule', reusable: false, reasons, next: '产物完整性校验失败，重新取数。' };
  if (payload.snapshotPointer !== pointer) reasons.push('snapshot-changed');
  if (!(Date.parse(payload.expiresAt) > now) || Date.parse(payload.createdAt) > now) reasons.push('expired');
  // Revalidate referenced query/parameter files before reusing any result.
  const hashes: string[] = [];
  if (Array.isArray(payload.argv)) for (let i = 0; i < payload.argv.length; i++) {
    if (['--file', '--params-file', '--input'].includes(payload.argv[i])) {
      const path = resolve(workspace, payload.argv[++i]);
      if (!within(workspace, path)) { reasons.push('input-outside-workspace'); break; }
      hashes.push(fingerprint(await readFile(path, 'utf8').catch(() => 'missing')));
    }
  }
  if (fingerprint(hashes) !== fingerprint(payload.inputHashes)) reasons.push('input-changed');
  if (payload.result?.manifestPath) {
    try {
      const manifestPath = await realpath(payload.result.manifestPath);
      const resultPath = await realpath(payload.result.resultPath);
      const root = await realpath(workspace);
      if (!within(root, manifestPath) || !within(root, resultPath)) throw new Error('outside');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const { createHash } = await import('node:crypto');
      const { sha256File } = await import('./snapshotManifest.js');
      const item = manifest.outputs?.[0];
      const file = item?.files?.[0];
      const digest = await sha256File(resultPath);
      if (manifest.snapshot?.snapshotId !== payload.result.snapshotId || file?.sha256 !== digest
        || item.sha256 !== createHash('sha256').update(`${file.relativePath}|${file.bytes}|${digest}\n`).digest('hex')) throw new Error('changed');
    } catch { reasons.push('result-artifact-changed'); }
  }
  return { kind: 'research-capsule', reusable: reasons.length === 0, reasons,
    command: payload.argv, validation: payload.validation,
    ...(reasons.length ? { next: '保留方法和口径；重新执行受影响取数，不复用旧数值。' } : { result: payload.result }),
    note: '仅适用于记录中的相同参数与口径；日期、证券池、复权或假设变化必须重新计算。' };
}
