import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStorageHealth } from '../services/storageHealthService';

const GIB = 1024 ** 3;

describe('checkStorageHealth', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-health-'));
    fs.mkdirSync(path.join(dataRoot, 'workspaces'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const base = () => ({
    dataRoot,
    requireWorkspaceMount: true,
    readMounts: async () =>
      `//share.file.core.windows.net/ws ${path.join(dataRoot, 'workspaces')} cifs rw 0 0\n`,
    readFreeBytes: async () => 50 * GIB,
    minFreeBytes: 10 * GIB,
  });

  it('passes when the data root is writable, the share is mounted and space is free', async () => {
    await expect(checkStorageHealth(base())).resolves.toEqual({
      status: 'ok',
      checks: { dataRoot: 'ok', workspaceMount: 'ok', freeSpace: 'ok' },
    });
  });

  it('fails when the workspace share is not mounted, even though the folder exists', async () => {
    const report = await checkStorageHealth({
      ...base(),
      readMounts: async () => '/dev/sda1 / ext4 rw 0 0\n',
    });
    expect(report).toMatchObject({ status: 'failed', checks: { workspaceMount: 'failed' } });
  });

  it('fails when free space is below what a clone needs', async () => {
    const report = await checkStorageHealth({ ...base(), readFreeBytes: async () => 2 * GIB });
    expect(report).toMatchObject({ status: 'failed', checks: { freeSpace: 'failed' } });
  });

  it('skips the mount check outside App Service', async () => {
    const report = await checkStorageHealth({
      ...base(),
      requireWorkspaceMount: false,
      readMounts: async () => {
        throw new Error('no /proc/mounts');
      },
    });
    expect(report.checks.workspaceMount).toBe('ok');
  });
});
