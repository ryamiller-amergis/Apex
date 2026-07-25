/**
 * Unit tests — FEAT-008 containerAppsJobRunner / loadTestRunner
 *
 * Traceability:
 *   TBI-008 DoD-0..3, PBI-010 AC-0..3, VT-01..VT-04, TC-PBI-010-001..005
 */
import type {
  LoadTestDispatchMessage,
  LoadTestRunIngestBody,
  ThresholdResult,
} from '../../shared/types/loadTest';
import {
  buildLoadTestArtifactKey,
  createContainerAppsJobRunner,
  mapK6ThresholdResults,
  stripExportedOptions,
  type LoadTestRunnerDeps,
  type K6RunResult,
} from '../services/loadTestRunner';

const BASE_DISPATCH: LoadTestDispatchMessage = {
  dispatchMessageId: 'msg-1',
  projectId: 'project-a',
  runId: 'run-1',
  definitionId: 'def-1',
  targetUrl: 'https://staging.example.com',
  environment: 'staging',
  script: 'export default function () { /* persisted */ }',
  loadProfile: {
    vus: 5,
    durationMinutes: 1,
    stages: [
      { duration: '10s', target: 5 },
      { duration: '10s', target: 5 },
    ],
  },
  clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
  secretRefs: { API_TOKEN: 'kv://myvault/api-token' },
  callbackBaseUrl: 'https://apex.example.com',
};

function createDeps(overrides: Partial<LoadTestRunnerDeps> = {}): {
  deps: LoadTestRunnerDeps;
  calls: {
    allowlist: LoadTestDispatchMessage[];
    secrets: Record<string, string>[];
    k6: Array<{ script: string; env: Record<string, string> }>;
    blob: Array<{ key: string; body: string }>;
    ingest: LoadTestRunIngestBody[];
  };
} {
  const calls = {
    allowlist: [] as LoadTestDispatchMessage[],
    secrets: [] as Record<string, string>[],
    k6: [] as Array<{ script: string; env: Record<string, string> }>,
    blob: [] as Array<{ key: string; body: string }>,
    ingest: [] as LoadTestRunIngestBody[],
  };

  let cancelAfterProgress = 0;
  let progressCount = 0;

  const deps: LoadTestRunnerDeps = {
    assertAllowlist: async (dispatch) => {
      calls.allowlist.push(dispatch);
    },
    resolveSecrets: async (refs) => {
      calls.secrets.push(refs);
      const out: Record<string, string> = {};
      for (const [k] of Object.entries(refs)) {
        out[k] = `resolved-${k}`;
      }
      return out;
    },
    runK6: async (opts) => {
      calls.k6.push({ script: opts.script, env: { ...opts.env } });
      const result: K6RunResult = {
        exitCode: 0,
        summary: {
          metrics: {
            http_req_failed: {
              thresholds: { 'rate<0.01': { ok: true } },
              values: { rate: 0.001 },
            },
          },
          root_group: { checks: [] },
        },
        timeseries: [{ t: 0, vus: 5 }],
        stagesCompleted: opts.stages?.length ?? 1,
      };
      return result;
    },
    progressHeartbeatMs: 0,
    uploadArtifact: async (key, body) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      calls.blob.push({ key, body: text });
      return { container: 'lt-artifacts', key };
    },
    postIngest: async (_projectId, _runId, body) => {
      calls.ingest.push(body);
      if (body.kind === 'progress') {
        progressCount += 1;
        const cancelRequested =
          cancelAfterProgress > 0 && progressCount >= cancelAfterProgress;
        return { ok: true, cancelRequested };
      }
      return { ok: true, cancelRequested: false };
    },
    ...overrides,
  };

  // Expose cancel helper via closure for tests that replace postIngest
  (deps as LoadTestRunnerDeps & { __setCancelAfter?: (n: number) => void }).__setCancelAfter = (
    n: number,
  ) => {
    cancelAfterProgress = n;
    progressCount = 0;
  };

  return { deps, calls };
}

describe('loadTestRunner helpers', () => {
  it('buildLoadTestArtifactKey builds project/run/name and rejects unsafe segments', () => {
    expect(
      buildLoadTestArtifactKey({
        projectId: 'proj-1',
        runId: 'run-1',
        fileName: 'summary.json',
      }),
    ).toBe('proj-1/run-1/summary.json');

    expect(() =>
      buildLoadTestArtifactKey({
        projectId: '../evil',
        runId: 'run-1',
        fileName: 'summary.json',
      }),
    ).toThrow(/projectId/);
  });

  it('mapK6ThresholdResults maps client thresholds against k6 summary (DoD threshold mapping)', () => {
    const results = mapK6ThresholdResults(
      [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
      {
        metrics: {
          http_req_failed: {
            thresholds: { 'rate<0.01': { ok: true } },
            values: { rate: 0.002 },
          },
        },
      },
    );
    expect(results).toEqual<ThresholdResult[]>([
      {
        metric: 'http_req_failed',
        expression: 'rate<0.01',
        passed: true,
        observed: 0.002,
        evaluated: true,
      },
    ]);
  });

  it('mapK6ThresholdResults marks missing ok as evaluated:false (not a silent Fail)', () => {
    const results = mapK6ThresholdResults(
      [
        { metric: 'http_req_duration', expression: 'p(95)<500' },
        { metric: 'http_req_failed', expression: 'rate<0.01' },
      ],
      { metrics: {} },
    );
    expect(results.every((r) => r.evaluated === false)).toBe(true);
    expect(results.every((r) => r.observed == null)).toBe(true);
  });

  it('stripExportedOptions removes a guided-script options block so executor injects one', () => {
    const guided = `import http from 'k6/http';
export const options = {
  vus: 5,
  duration: '1m',
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export default function () {
  http.get(__ENV.TARGET_URL);
}
`;
    const stripped = stripExportedOptions(guided);
    expect(stripped).not.toMatch(/export\s+const\s+options/);
    expect(stripped).toContain('export default function');
    expect(stripped).toContain('http.get');
  });
});

describe('containerAppsJobRunner — TBI-008 / PBI-010', () => {
  it('DoD-0 / AC-0 / VT-01: executes persisted script with injected secrets and posts threshold results', async () => {
    const { deps, calls } = createDeps();
    const runner = createContainerAppsJobRunner(deps);

    await runner.execute(BASE_DISPATCH);

    expect(calls.allowlist).toHaveLength(1);
    expect(calls.secrets).toEqual([{ API_TOKEN: 'kv://myvault/api-token' }]);
    expect(calls.k6).toHaveLength(BASE_DISPATCH.loadProfile.stages!.length);
    expect(calls.k6[0].script).toBe(BASE_DISPATCH.script);
    expect(calls.k6[0].env.API_TOKEN).toBe('resolved-API_TOKEN');
    expect(calls.k6[0].env.API_TOKEN).not.toContain('kv://');

    const progress = calls.ingest.filter((b) => b.kind === 'progress');
    const finals = calls.ingest.filter((b) => b.kind === 'final');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(finals).toHaveLength(1);
    expect(finals[0].dispatchMessageId).toBe('msg-1');
    expect(finals[0].thresholdResults?.length).toBeGreaterThan(0);
    expect(finals[0].summaryBlobRef).toBeTruthy();
    expect(finals[0].timeseriesBlobRef).toBeTruthy();

    // Secrets never appear in Blob or callback payloads (BR-006)
    for (const blob of calls.blob) {
      expect(blob.body).not.toContain('resolved-API_TOKEN');
      expect(blob.body).not.toContain('kv://myvault/api-token');
    }
    for (const body of calls.ingest) {
      expect(JSON.stringify(body)).not.toContain('resolved-API_TOKEN');
    }
  });

  it('DoD-1: progress and final ingest succeed against Apex callback', async () => {
    const { deps, calls } = createDeps();
    const runner = createContainerAppsJobRunner(deps);
    await runner.execute(BASE_DISPATCH);

    expect(calls.ingest.some((b) => b.kind === 'progress')).toBe(true);
    expect(calls.ingest.some((b) => b.kind === 'final')).toBe(true);
    expect(calls.ingest.every((b) => b.dispatchMessageId === 'msg-1')).toBe(true);
  });

  it('DoD-3 / AC-1 / VT-02: allowlist failure aborts before k6 and fail-closes as errored', async () => {
    const { deps, calls } = createDeps({
      assertAllowlist: async () => {
        throw new Error('Target is not allowlisted / production refused');
      },
    });
    const runner = createContainerAppsJobRunner(deps);

    await runner.execute(BASE_DISPATCH);

    expect(calls.k6).toHaveLength(0);
    expect(calls.secrets).toHaveLength(0);
    expect(calls.blob).toHaveLength(0);
    const finals = calls.ingest.filter((b) => b.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0].errorDetail).toMatch(/allowlist|production|refused/i);
    expect(finals[0].thresholdResults ?? []).toHaveLength(0);
  });

  it('DoD-2 / AC-2 / VT-03: cancel_requested at stage boundary stops further stages and posts cancel_ack', async () => {
    const stageScripts: string[] = [];
    const { deps, calls } = createDeps({
      runK6: async (opts) => {
        stageScripts.push(opts.script);
        return {
          exitCode: 0,
          summary: {
            metrics: {
              http_req_failed: {
                thresholds: { 'rate<0.01': { ok: true } },
                values: { rate: 0 },
              },
            },
          },
          timeseries: [],
          stagesCompleted: 1,
        };
      },
      postIngest: async (_p, _r, body) => {
        calls.ingest.push(body);
        // Cancel when starting the second stage (after stage 0 ran).
        if (
          body.kind === 'progress' &&
          body.progress?.message === 'stage-running:1'
        ) {
          return { ok: true, cancelRequested: true };
        }
        return { ok: true, cancelRequested: false };
      },
    });

    const runner = createContainerAppsJobRunner(deps);
    await runner.execute(BASE_DISPATCH);

    const cancelAcks = calls.ingest.filter((b) => b.kind === 'cancel_ack');
    expect(cancelAcks).toHaveLength(1);
    expect(calls.ingest.some((b) => b.kind === 'final')).toBe(false);
    expect(stageScripts).toHaveLength(1);
    expect(stageScripts.length).toBeLessThan(BASE_DISPATCH.loadProfile.stages!.length);
  });

  it('empty k6 summary posts errored with stderr — not fake threshold Fail', async () => {
    const { deps, calls } = createDeps({
      runK6: async () => ({
        exitCode: 107,
        summary: { metrics: {} },
        timeseries: [],
        stagesCompleted: 0,
        stderr: 'SyntaxError: Identifier \'options\' has already been declared',
      }),
    });
    const runner = createContainerAppsJobRunner(deps);
    await runner.execute(BASE_DISPATCH);

    const finals = calls.ingest.filter((b) => b.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0].thresholdResults ?? []).toHaveLength(0);
    expect(finals[0].errorDetail).toMatch(/no usable metrics/i);
    expect(finals[0].errorDetail).toMatch(/already been declared/);
  });

  it('AC-3 / VT-04: Key Vault resolution failure errors without load or secret material in Blob', async () => {
    const { deps, calls } = createDeps({
      resolveSecrets: async () => {
        throw new Error('Key Vault secret not found');
      },
    });
    const runner = createContainerAppsJobRunner(deps);

    await runner.execute(BASE_DISPATCH);

    expect(calls.k6).toHaveLength(0);
    expect(calls.blob).toHaveLength(0);
    const finals = calls.ingest.filter((b) => b.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0].errorDetail).toMatch(/Key Vault|secret/i);
    expect(JSON.stringify(finals[0])).not.toContain('resolved-');
  });

  it('NFR / TC-PBI-010-006: posts progress heartbeats while preparing/running', async () => {
    const { deps, calls } = createDeps();
    const runner = createContainerAppsJobRunner(deps);
    await runner.execute(BASE_DISPATCH);

    const progress = calls.ingest.filter((b) => b.kind === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0].heartbeatAt).toBeTruthy();
    expect(progress[0].status === 'running' || progress[0].status === undefined).toBe(true);
  });
});
