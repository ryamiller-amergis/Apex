import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { K6RunOptions, K6RunResult } from './containerAppsJobRunner';

export type K6Executor = (opts: K6RunOptions) => Promise<K6RunResult>;

/**
 * Remove an existing `export const options = { ... }` so the executor can inject
 * exactly one options block (profile + thresholds from the dispatch).
 * Guided/AI scripts already emit options; prepending a second block makes k6
 * fail at load time and produces an empty summary (Fail with Observed "—").
 */
export function stripExportedOptions(script: string): string {
  const match = /export\s+const\s+options\s*=/.exec(script);
  if (!match || match.index === undefined) return script;

  const start = match.index;
  let i = start + match[0].length;
  while (i < script.length && /\s/.test(script[i]!)) i += 1;
  if (script[i] !== '{') return script;

  let depth = 0;
  for (; i < script.length; i += 1) {
    const ch = script[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < script.length) {
        if (script[i] === '\\') {
          i += 2;
          continue;
        }
        if (script[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        while (i < script.length && /[\s;]/.test(script[i]!)) i += 1;
        return `${script.slice(0, start)}${script.slice(i)}`.replace(/^\s+/, '');
      }
    }
  }

  return script;
}

/**
 * Spawn the k6 binary with the persisted script and profile/thresholds.
 * Metric-only: uses --summary-export; does not capture response bodies.
 */
export function createProcessK6Executor(options?: {
  k6Path?: string;
  spawnImpl?: typeof spawn;
}): K6Executor {
  const k6Path = options?.k6Path || process.env.K6_PATH || 'k6';
  const spawnImpl = options?.spawnImpl ?? spawn;

  return async (opts) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-k6-'));
    const scriptPath = path.join(tmpDir, 'script.js');
    const summaryPath = path.join(tmpDir, 'summary.json');

    const thresholds: Record<string, string[]> = {};
    for (const t of opts.clientThresholds) {
      if (!thresholds[t.metric]) thresholds[t.metric] = [];
      thresholds[t.metric].push(t.expression);
    }

    const stage = opts.stages?.[0];
    const duration = stage?.duration || `${opts.loadProfile.durationMinutes}m`;
    const vus = stage?.target ?? opts.loadProfile.vus;

    // Inject a single options block. Strip any script-embedded options first so
    // guided/AI scripts (which already export options) do not double-declare.
    const requestLogic = stripExportedOptions(opts.script);
    const wrapped = `
export const options = {
  vus: ${Number(vus) || 1},
  duration: ${JSON.stringify(duration)},
  thresholds: ${JSON.stringify(thresholds)},
};
${requestLogic}
`;

    await fs.writeFile(scriptPath, wrapped, 'utf8');

    const env = {
      ...process.env,
      ...opts.env,
      TARGET_URL: opts.targetUrl,
    };

    let stderr = '';
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawnImpl(
        k6Path,
        ['run', scriptPath, '--summary-export', summaryPath],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        // Cap retained stderr so we never store huge logs in ingest payloads.
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });

    let summary: unknown = { metrics: {} };
    try {
      const raw = await fs.readFile(summaryPath, 'utf8');
      summary = JSON.parse(raw);
    } catch {
      summary = { metrics: {} };
    }

    // Best-effort cleanup of temp script (never log secret env values).
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

    return {
      exitCode,
      summary,
      timeseries: [],
      stagesCompleted: 1,
      stderr: stderr.trim() || undefined,
    };
  };
}
