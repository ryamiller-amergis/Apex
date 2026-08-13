import fs from 'fs';
import path from 'path';
import { git, safeArgs } from '../utils/asyncGit';
import {
  COLD_CACHE_IDLE_TIMEOUT_MS,
  COLD_CACHE_TIMEOUT_MS,
  ensureGitSafeDirectory,
} from './repoGitSettings';

export async function materializeWorkspaceFromCache(
  cacheDir: string,
  workspaceDir: string,
  branch: string,
  remoteUrl: string
): Promise<void> {
  const startedAt = Date.now();
  const workspaceLabel = path.basename(workspaceDir);
  console.log(
    `[repo-workspace] phase=materialize-start session=${workspaceLabel} branch=${branch}`
  );
  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  try {
    // `git clone --no-local` spawns a separate upload-pack transport process to
    // read the bare cache mirror; that child does not inherit the per-command
    // `-c safe.directory` below, so on Azure Files it aborts with
    // `fatal: detected dubious ownership`. Trust all repos at the global config
    // level first so the transport helper also clears the guard.
    await ensureGitSafeDirectory();
    await git(
      safeArgs(cacheDir, [
        '-c',
        'core.longpaths=true',
        'clone',
        '--reference',
        cacheDir,
        '--no-local',
        '--no-hardlinks',
        '--single-branch',
        '--progress',
        '--branch',
        branch,
        cacheDir,
        workspaceDir,
      ]),
      {
        cwd: path.dirname(workspaceDir),
        timeout: COLD_CACHE_TIMEOUT_MS,
        idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
      }
    );
    await git(
      safeArgs(workspaceDir, ['remote', 'set-url', 'origin', remoteUrl]),
      { cwd: workspaceDir }
    );
    console.log(
      `[repo-workspace] phase=materialize-complete session=${workspaceLabel} ` +
        `branch=${branch} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    console.error(
      `[repo-workspace] phase=materialize-failed session=${workspaceLabel} ` +
        `branch=${branch} durationMs=${Date.now() - startedAt}:`,
      (err as Error).message
    );
    throw err;
  }
}
