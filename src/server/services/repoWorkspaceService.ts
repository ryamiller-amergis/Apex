import fs from 'fs';
import path from 'path';
import { git, safeArgs } from '../utils/asyncGit';
import {
  COLD_CACHE_IDLE_TIMEOUT_MS,
  COLD_CACHE_TIMEOUT_MS,
} from './repoGitSettings';

export async function materializeWorkspaceFromCache(
  cacheDir: string,
  workspaceDir: string,
  branch: string,
  remoteUrl: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  try {
    await git([
      '-c',
      'core.longpaths=true',
      'clone',
      '--reference-if-able',
      cacheDir,
      '--dissociate',
      '--single-branch',
      '--branch',
      branch,
      cacheDir,
      workspaceDir,
    ], {
      cwd: path.dirname(workspaceDir),
      timeout: COLD_CACHE_TIMEOUT_MS,
      idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
    });
    await git(
      safeArgs(workspaceDir, ['remote', 'set-url', 'origin', remoteUrl]),
      { cwd: workspaceDir },
    );
  } catch (err) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    throw err;
  }
}
