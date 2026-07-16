import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

export interface StagedOutput {
  requestedPath: string;
  stagingPath: string;
  isDirectory: boolean;
}

export async function createStagedOutput(
  requestedPathInput: string,
  isDirectory = false,
): Promise<StagedOutput> {
  const requestedPath = resolve(requestedPathInput);
  await mkdir(dirname(requestedPath), { recursive: true });
  const stagingPath = join(
    dirname(requestedPath),
    `.${basename(requestedPath)}.${randomUUID().slice(0, 8)}.partial`,
  );
  if (isDirectory) await mkdir(stagingPath, { recursive: true });
  return { requestedPath, stagingPath, isDirectory };
}

export async function finalizeStagedOutput(staged: StagedOutput): Promise<string> {
  let target = staged.requestedPath;
  if (await pathExists(target)) target = await availableTimestampedPath(target);
  try {
    await rename(staged.stagingPath, target);
    return target;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EPERM', 'EEXIST', 'ENOTEMPTY'].includes(code ?? '')) throw error;
    target = await availableTimestampedPath(staged.requestedPath);
    await rename(staged.stagingPath, target);
    return target;
  }
}

export async function discardStagedOutput(staged: StagedOutput): Promise<void> {
  await rm(staged.stagingPath, { recursive: staged.isDirectory, force: true }).catch(() => undefined);
}

export async function writeTextOutputAtomic(
  requestedPathInput: string,
  content: string,
): Promise<string> {
  const staged = await createStagedOutput(requestedPathInput);
  try {
    await writeFile(staged.stagingPath, content, 'utf8');
    return await finalizeStagedOutput(staged);
  } catch (error) {
    await discardStagedOutput(staged);
    throw error;
  }
}

async function availableTimestampedPath(path: string): Promise<string> {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? stamp : `${stamp}-${index}`;
    const candidate = `${stem}-${suffix}${extension}`;
    if (!await pathExists(candidate)) return candidate;
  }
  throw new Error(`无法为被占用的输出分配新文件名：${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
