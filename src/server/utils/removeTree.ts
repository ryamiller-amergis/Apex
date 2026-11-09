import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const MAX_STDERR_CHARS = 2_000;

/**
 * Deletes a directory tree in an `rm -rf` child process. `fs.promises.rm` runs
 * each unlink on the four-thread libuv pool; on the Azure Files mount a large
 * tree holds every thread for minutes, so DNS lookups and new Postgres
 * connections on the instance time out. Missing paths resolve, like
 * `{ force: true }`.
 */
export function removeTree(target: string): Promise<void> {
  if (process.platform === 'win32') {
    return fs.promises.rm(target, { recursive: true, force: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn('rm', ['-rf', '--', target], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail =
        stderr.trim().slice(0, MAX_STDERR_CHARS) || `exit code ${code}`;
      reject(new Error(`rm -rf ${path.basename(target)} failed: ${detail}`));
    });
  });
}
