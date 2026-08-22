import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicAccessControl, type PublicAccessStatus } from './publicAccess.js';

const temporaryDirectories: string[] = [];

function makeStatus(enabled: boolean, running = enabled): PublicAccessStatus {
  return {
    available: true,
    enabled,
    running,
    domain: 'https://stock.clical.xin',
    tasks: [],
    message: null,
  };
}

async function makeStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'public-access-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'public-access.json');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('public access persistence', () => {
  it('records the current task state on first use without changing it', async () => {
    const stateFilePath = await makeStatePath();
    const invoke = vi.fn(async () => makeStatus(true));
    const control = createPublicAccessControl({ invoke, stateFilePath });

    await expect(control.reconcile()).resolves.toMatchObject({ enabled: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(stateFilePath, 'utf8'))).toMatchObject({ enabled: true });
  });

  it('persists disable intent before stopping the tasks', async () => {
    const stateFilePath = await makeStatePath();
    const invoke = vi.fn(async (action: string) => makeStatus(action === 'enable'));
    const control = createPublicAccessControl({ invoke, stateFilePath });

    await control.setEnabled(false);

    expect(invoke).toHaveBeenCalledWith('disable');
    expect(JSON.parse(await readFile(stateFilePath, 'utf8'))).toMatchObject({ enabled: false });
  });

  it('disables tasks again after restart when persisted intent is off', async () => {
    const stateFilePath = await makeStatePath();
    const firstInvoke = vi.fn(async () => makeStatus(false, false));
    await createPublicAccessControl({ invoke: firstInvoke, stateFilePath }).setEnabled(false);

    const restartInvoke = vi.fn(async (action: string) => (
      action === 'status' ? makeStatus(true, true) : makeStatus(false, false)
    ));
    const restartedControl = createPublicAccessControl({ invoke: restartInvoke, stateFilePath });

    await expect(restartedControl.reconcile()).resolves.toMatchObject({ enabled: false, running: false });
    expect(restartInvoke.mock.calls.map(([action]) => action)).toEqual(['status', 'disable']);
  });

  it('fails closed when the persisted state is malformed', async () => {
    const stateFilePath = await makeStatePath();
    await writeFile(stateFilePath, '{not-json', 'utf8');
    const invoke = vi.fn(async (action: string) => (
      action === 'status' ? makeStatus(true, true) : makeStatus(false, false)
    ));
    const control = createPublicAccessControl({ invoke, stateFilePath });

    await expect(control.reconcile()).resolves.toMatchObject({ enabled: false, running: false });
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['status', 'disable']);
  });

  it('does not auto-enable tasks merely because the persisted intent is on', async () => {
    const stateFilePath = await makeStatePath();
    const invoke = vi.fn(async (action: string) => makeStatus(action === 'enable'));
    const control = createPublicAccessControl({ invoke, stateFilePath });
    await control.setEnabled(true);
    invoke.mockClear();

    await expect(control.reconcile()).resolves.toMatchObject({ enabled: false });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('status');
  });
});
