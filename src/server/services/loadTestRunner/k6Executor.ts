import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { K6RunOptions, K6RunResult } from './containerAppsJobRunner';

export type K6Executor = (opts: K6RunOptions) => Promise<K6RunResult>;

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

    // Prepend options so the persisted script remains the request logic source of truth.
    const wrapped = `
export const options = {
  vus: ${Number(vus) || 1},
  duration: ${JSON.stringify(duration)},
  thresholds: ${JSON.stringify(thresholds)},
};
${opts.script}
`;

    await fs.writeFile(scriptPath, wrapped, 'utf8');

    const env = {
      ...process.env,
      ...opts.env,
      TARGET_URL: opts.targetUrl,
    };

    // Ensure secrets are present for the child only via opts.env (already merged).
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawnImpl(
        k6Path,
        ['run', scriptPath, '--summary-export', summaryPath],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
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
    };
  };
}
