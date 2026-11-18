import fs from 'fs';
import os from 'os';
import path from 'path';

const mockLimit = jest.fn();
const mockDeleteWhere = jest.fn().mockResolvedValue(undefined);
const mockOnConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
const mockValues = jest.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) })),
    insert: jest.fn(() => ({ values: mockValues })),
    delete: jest.fn(() => ({ where: mockDeleteWhere })),
  },
}));

jest.mock('../services/featureFlagService', () => ({
  isFlagEnabledForWholeProject: jest.fn(),
}));

import { isFlagEnabledForWholeProject } from '../services/featureFlagService';
import {
  clearThreadOutput,
  readThreadOutput,
  saveThreadOutputs,
} from '../services/chatThreadOutputStore';
import { keepsThreadFolder, writeThreadFolderFile } from '../services/threadFolder';

const wholeV2 = isFlagEnabledForWholeProject as jest.Mock;

describe('chatThreadOutputStore', () => {
  let workspaceDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-output-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('reads the saved file before the thread folder', async () => {
    fs.mkdirSync(path.join(workspaceDir, '.ai-pilot', 'output'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.ai-pilot', 'output', 'a.json'), 'folder', 'utf-8');
    mockLimit.mockResolvedValueOnce([{ content: 'saved' }]);

    await expect(readThreadOutput({
      threadId: 't1',
      workspaceDir,
      relativePath: ['.ai-pilot', 'output', 'a.json'],
    })).resolves.toBe('saved');
  });

  it('falls back to the thread folder, and returns null when neither has the file', async () => {
    fs.mkdirSync(path.join(workspaceDir, '.ai-pilot'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.ai-pilot', 'a.md'), 'folder', 'utf-8');
    mockLimit.mockResolvedValue([]);

    await expect(readThreadOutput({ threadId: 't1', workspaceDir, relativePath: '.ai-pilot/a.md' }))
      .resolves.toBe('folder');
    await expect(readThreadOutput({ threadId: 't1', workspaceDir, relativePath: '.ai-pilot/b.md' }))
      .resolves.toBeNull();
    await expect(readThreadOutput({ threadId: 't1', relativePath: '.ai-pilot/a.md' }))
      .resolves.toBeNull();
  });

  it('upserts every file under the thread and skips an empty list', async () => {
    await saveThreadOutputs('t1', 'r1', []);
    expect(mockValues).not.toHaveBeenCalled();

    await saveThreadOutputs('t1', 'r1', [{ path: '.ai-pilot/output/a.json', content: '{}' }]);
    expect(mockValues).toHaveBeenCalledWith([
      { threadId: 't1', path: '.ai-pilot/output/a.json', content: '{}', runId: 'r1' },
    ]);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('clears the saved row and the folder copy', async () => {
    const file = path.join(workspaceDir, '.ai-pilot', 'a.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old', 'utf-8');

    await clearThreadOutput({ threadId: 't1', workspaceDir, relativePath: '.ai-pilot/a.md' });

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('threadFolder', () => {
  let workspaceDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-folder-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('keeps the folder unless the whole project is on V2, and keeps it when the flag lookup fails', async () => {
    wholeV2.mockResolvedValueOnce(true);
    await expect(keepsThreadFolder('Apex')).resolves.toBe(false);
    wholeV2.mockResolvedValueOnce(false);
    await expect(keepsThreadFolder('Apex')).resolves.toBe(true);
    wholeV2.mockRejectedValueOnce(new Error('db down'));
    await expect(keepsThreadFolder('Apex')).resolves.toBe(true);
  });

  it('writes the file only for projects that keep the folder', async () => {
    const target = path.join(workspaceDir, '.ai-pilot', 'kickoff-context.md');

    wholeV2.mockResolvedValueOnce(true);
    await writeThreadFolderFile({ project: 'Apex', workspaceDir, relativePath: '.ai-pilot/kickoff-context.md', content: 'x' });
    expect(fs.existsSync(target)).toBe(false);

    wholeV2.mockResolvedValueOnce(false);
    await writeThreadFolderFile({ project: 'Apex', workspaceDir, relativePath: '.ai-pilot/kickoff-context.md', content: 'x' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('x');
  });
});
