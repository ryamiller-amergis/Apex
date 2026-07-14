import { spawn } from 'child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000;

export { LONG_TIMEOUT_MS };

export interface GitOptions {
  cwd?: string;
  timeout?: number;
  idleTimeout?: number;
  abortSignal?: AbortSignal;
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
    idleTimeout,
    abortSignal,
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
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let killed = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let terminationError: Error | undefined;
    let timer: NodeJS.Timeout;
    const knownCommands = new Set(['clone', 'fetch', 'push', 'pull', 'ls-remote']);
    const commandName = args.find((arg) => knownCommands.has(arg)) ?? args[0];

    const clearTimers = () => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const finishTermination = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(terminationError ?? new Error(`git ${commandName} terminated`));
    };

    const killProcessTree = () => {
      if (!child.pid) {
        child.kill('SIGKILL');
        return;
      }
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => child.kill('SIGKILL'));
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const rejectAndKill = (message: string) => {
      if (settled || killed) return;
      killed = true;
      terminationError = new Error(message);
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      killProcessTree();
    };

    const resetIdleTimer = () => {
      if (!idleTimeout) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        rejectAndKill(`git ${commandName} made no progress for ${idleTimeout}ms`);
      }, idleTimeout);
    };

    timer = setTimeout(() => {
      rejectAndKill(`git ${commandName} timed out after ${timeout}ms`);
    }, timeout);
    const onAbort = () => {
      const reason = abortSignal?.reason;
      rejectAndKill(reason instanceof Error ? reason.message : `git ${commandName} aborted`);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    resetIdleTimer();

    child.stdout.on('data', (chunk: Buffer) => {
      resetIdleTimer();
      totalBytes += chunk.length;
      if (totalBytes <= maxBuffer) stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      resetIdleTimer();
      totalBytes += chunk.length;
      if (totalBytes <= maxBuffer) stderr.push(chunk);
    });

    child.on('error', (err) => {
      if (settled) return;
      if (killed) {
        finishTermination();
        return;
      }
      settled = true;
      clearTimers();
      reject(err);
    });

    child.on('close', (code) => {
      if (killed) {
        finishTermination();
        return;
      }
      clearTimers();
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const errMsg = Buffer.concat(stderr).toString('utf-8').trim()
          || Buffer.concat(stdout).toString('utf-8').trim()
          || `exit code ${code}`;
        reject(new Error(`git ${commandName} failed: ${errMsg}`));
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
