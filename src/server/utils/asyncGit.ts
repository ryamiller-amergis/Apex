import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;

export { LONG_TIMEOUT_MS };

export interface GitOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  maxBuffer?: number;
}

/**
 * Spawns a git subprocess with the given args, kills on timeout, and returns
 * stdout. Sets GIT_TERMINAL_PROMPT=0 to prevent hanging on credential prompts.
 */
export function git(args: string[], options: GitOptions = {}): Promise<string> {
  const {
    cwd,
    timeout = DEFAULT_TIMEOUT_MS,
    env: extraEnv,
    maxBuffer = 10 * 1024 * 1024,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= maxBuffer) stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= maxBuffer) stderr.push(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        const errMsg = Buffer.concat(stderr).toString('utf-8').trim()
          || Buffer.concat(stdout).toString('utf-8').trim()
          || `exit code ${code}`;
        reject(new Error(`git ${args[0]} failed: ${errMsg}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf-8'));
    });
  });
}

/**
 * Builds args array that includes `-c safe.directory=<dir>` to bypass the
 * dubious-ownership guard on Azure Files.
 */
export function safeArgs(workspaceDir: string, args: string[]): string[] {
  return ['-c', `safe.directory=${workspaceDir}`, ...args];
}
