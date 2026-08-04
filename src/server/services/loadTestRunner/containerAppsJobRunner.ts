import type {
  ArtifactRef,
  LoadTestDispatchMessage,
  LoadTestRunner,
  LoadTestRunIngestBody,
  LoadProfileStage,
} from '../../../shared/types/loadTest';
import { buildLoadTestArtifactKey } from './artifactKey';
import { mapK6ThresholdResults, summaryHasMetrics } from './thresholdMapper';

export type IngestResponse = {
  ok: boolean;
  cancelRequested: boolean;
};

export type K6RunOptions = {
  script: string;
  env: Record<string, string>;
  targetUrl: string;
  loadProfile: LoadTestDispatchMessage['loadProfile'];
  clientThresholds: LoadTestDispatchMessage['clientThresholds'];
  /** When set, executor should run only this stage slice */
  stages?: LoadProfileStage[];
  stageIndex?: number;
};

export type K6RunResult = {
  exitCode: number;
  summary: unknown;
  timeseries: unknown;
  stagesCompleted: number;
  /** Truncated k6 stderr for diagnosis when summary is empty */
  stderr?: string;
};

export type LoadTestRunnerDeps = {
  assertAllowlist: (dispatch: LoadTestDispatchMessage) => Promise<void>;
  resolveSecrets: (refs: Record<string, string>) => Promise<Record<string, string>>;
  runK6: (opts: K6RunOptions) => Promise<K6RunResult>;
  uploadArtifact: (key: string, body: string | Buffer) => Promise<ArtifactRef>;
  postIngest: (
    projectId: string,
    runId: string,
    body: LoadTestRunIngestBody,
  ) => Promise<IngestResponse>;
  now?: () => Date;
  /** Progress heartbeat interval while k6 is executing (ms). Default 5s. */
  progressHeartbeatMs?: number;
};

function metricOnlySummary(summary: unknown): string {
  // Strip anything that could look like response bodies; keep metrics only.
  const safe =
    summary && typeof summary === 'object'
      ? { metrics: (summary as { metrics?: unknown }).metrics ?? {} }
      : { metrics: {} };
  return JSON.stringify(safe);
}

function formatEmptySummaryError(
  exitCode: number,
  stderr: string | undefined,
  reason: 'empty_metrics' | 'unevaluated_thresholds',
): string {
  const base =
    reason === 'empty_metrics'
      ? `k6 produced no usable metrics (exit ${exitCode}). ` +
        'This usually means the script failed to load or never issued requests — ' +
        'not that an SLO threshold was breached.'
      : `k6 returned metrics but Apex could not read threshold evaluation results (exit ${exitCode}). ` +
        'This is usually a summary-format mismatch, not an SLO breach.';
  const trimmed = stderr?.trim();
  if (!trimmed) return base;
  return `${base}\n\nk6 stderr:\n${trimmed.slice(0, 4000)}`;
}

/**
 * v1 LoadTestRunner implementation for Azure Container Apps Jobs.
 */
export function createContainerAppsJobRunner(
  deps: LoadTestRunnerDeps,
): LoadTestRunner {
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  const heartbeatMs = deps.progressHeartbeatMs ?? 5000;

  async function postProgress(
    dispatch: LoadTestDispatchMessage,
    progress?: { vu?: number; iteration?: number; message?: string },
  ): Promise<boolean> {
    const res = await deps.postIngest(dispatch.projectId, dispatch.runId, {
      dispatchMessageId: dispatch.dispatchMessageId,
      kind: 'progress',
      status: 'running',
      heartbeatAt: now(),
      progress,
    });
    return res.cancelRequested;
  }

  async function postFinalError(
    dispatch: LoadTestDispatchMessage,
    errorDetail: string,
    artifacts?: {
      summaryBlobRef?: ArtifactRef;
      timeseriesBlobRef?: ArtifactRef;
    },
  ): Promise<void> {
    await deps.postIngest(dispatch.projectId, dispatch.runId, {
      dispatchMessageId: dispatch.dispatchMessageId,
      kind: 'final',
      heartbeatAt: now(),
      errorDetail,
      thresholdResults: [],
      summaryBlobRef: artifacts?.summaryBlobRef,
      timeseriesBlobRef: artifacts?.timeseriesBlobRef,
    });
  }

  /**
   * Run k6 while posting periodic progress so the UI can leave dispatched → running
   * and show live heartbeats instead of only a terminal "k6-finished".
   */
  async function runK6WithHeartbeats(
    dispatch: LoadTestDispatchMessage,
    opts: Parameters<LoadTestRunnerDeps['runK6']>[0],
    message: string,
  ): Promise<{ result: K6RunResult; cancelled: boolean }> {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const cancel = await postProgress(dispatch, { message });
      if (cancel) cancelled = true;
    };

    // Immediate running heartbeat before the possibly long k6 spawn.
    await tick();
    if (cancelled) {
      return {
        result: {
          exitCode: 0,
          summary: { metrics: {} },
          timeseries: [],
          stagesCompleted: 0,
        },
        cancelled: true,
      };
    }

    let interval: ReturnType<typeof setInterval> | undefined;
    if (heartbeatMs > 0) {
      interval = setInterval(() => {
        void tick();
      }, heartbeatMs);
    }

    try {
      const result = await deps.runK6(opts);
      return { result, cancelled };
    } finally {
      if (interval) clearInterval(interval);
    }
  }

  return {
    async execute(dispatch: LoadTestDispatchMessage): Promise<void> {
      const injectedKeys: string[] = [];

      try {
        // Heartbeat as soon as preparation starts (cold start is not failure).
        const cancelEarly = await postProgress(dispatch, {
          message: 'preparing',
        });
        if (cancelEarly) {
          await deps.postIngest(dispatch.projectId, dispatch.runId, {
            dispatchMessageId: dispatch.dispatchMessageId,
            kind: 'cancel_ack',
            heartbeatAt: now(),
            errorDetail: 'Cancelled before execution started',
          });
          return;
        }

        // Final allowlist / non-prod assertion before any traffic (BR-001).
        try {
          await deps.assertAllowlist(dispatch);
        } catch (err) {
          const detail =
            err instanceof Error
              ? err.message
              : 'Allowlist/non-prod check failed';
          await postFinalError(dispatch, detail);
          return;
        }

        // Resolve Key Vault secrets (BR-006) — fail closed, no load.
        let secretEnv: Record<string, string> = {};
        try {
          if (Object.keys(dispatch.secretRefs || {}).length > 0) {
            secretEnv = await deps.resolveSecrets(dispatch.secretRefs);
            injectedKeys.push(...Object.keys(secretEnv));
          }
        } catch (err) {
          const detail =
            err instanceof Error
              ? err.message
              : 'Key Vault secret resolution failed';
          await postFinalError(
            dispatch,
            detail.match(/key vault|secret/i)
              ? detail
              : `Key Vault secret resolution failed: ${detail}`,
          );
          return;
        }

        const stages =
          dispatch.loadProfile.stages && dispatch.loadProfile.stages.length > 0
            ? dispatch.loadProfile.stages
            : undefined;

        let lastSummary: unknown = { metrics: {} };
        let lastTimeseries: unknown = [];
        let lastExitCode = 0;
        let lastStderr: string | undefined;
        let cancelled = false;

        if (stages) {
          for (let i = 0; i < stages.length; i++) {
            const { result, cancelled: stageCancelled } = await runK6WithHeartbeats(
              dispatch,
              {
                script: dispatch.script,
                env: { ...secretEnv, TARGET_URL: dispatch.targetUrl },
                targetUrl: dispatch.targetUrl,
                loadProfile: dispatch.loadProfile,
                clientThresholds: dispatch.clientThresholds,
                stages: [stages[i]],
                stageIndex: i,
              },
              `stage-running:${i}`,
            );
            if (stageCancelled) {
              cancelled = true;
              break;
            }
            lastSummary = result.summary;
            lastTimeseries = result.timeseries;
            lastExitCode = result.exitCode;
            lastStderr = result.stderr;
          }
        } else {
          const { result, cancelled: runCancelled } = await runK6WithHeartbeats(
            dispatch,
            {
              script: dispatch.script,
              env: { ...secretEnv, TARGET_URL: dispatch.targetUrl },
              targetUrl: dispatch.targetUrl,
              loadProfile: dispatch.loadProfile,
              clientThresholds: dispatch.clientThresholds,
            },
            'k6-running',
          );
          if (runCancelled) {
            cancelled = true;
          } else {
            lastSummary = result.summary;
            lastTimeseries = result.timeseries;
            lastExitCode = result.exitCode;
            lastStderr = result.stderr;

            const cancelAfter = await postProgress(dispatch, {
              message: 'k6-finished',
            });
            if (cancelAfter) cancelled = true;
          }
        }

        // Scrub injected secrets from process env when present.
        for (const key of injectedKeys) {
          if (process.env[key] !== undefined) {
            delete process.env[key];
          }
        }

        if (cancelled) {
          await deps.postIngest(dispatch.projectId, dispatch.runId, {
            dispatchMessageId: dispatch.dispatchMessageId,
            kind: 'cancel_ack',
            heartbeatAt: now(),
            errorDetail: 'Cancelled at stage boundary',
          });
          return;
        }

        const summaryKey = buildLoadTestArtifactKey({
          projectId: dispatch.projectId,
          runId: dispatch.runId,
          fileName: 'summary.json',
        });
        const timeseriesKey = buildLoadTestArtifactKey({
          projectId: dispatch.projectId,
          runId: dispatch.runId,
          fileName: 'timeseries.json',
        });

        const summaryRef = await deps.uploadArtifact(
          summaryKey,
          metricOnlySummary(lastSummary),
        );
        const timeseriesRef = await deps.uploadArtifact(
          timeseriesKey,
          JSON.stringify(lastTimeseries ?? []),
        );

        const thresholdResults = mapK6ThresholdResults(
          dispatch.clientThresholds,
          lastSummary as Parameters<typeof mapK6ThresholdResults>[1],
        );

        const metricsOk = summaryHasMetrics(
          lastSummary as Parameters<typeof summaryHasMetrics>[0],
        );
        const allEvaluated =
          thresholdResults.length === 0 ||
          thresholdResults.every((r) => r.evaluated !== false);

        // Empty/unevaluated summary → errored with stderr, never fake SLO Fail.
        if (!metricsOk || !allEvaluated) {
          await postFinalError(
            dispatch,
            formatEmptySummaryError(
              lastExitCode,
              lastStderr,
              !metricsOk ? 'empty_metrics' : 'unevaluated_thresholds',
            ),
            {
              summaryBlobRef: summaryRef,
              timeseriesBlobRef: timeseriesRef,
            },
          );
          return;
        }

        await deps.postIngest(dispatch.projectId, dispatch.runId, {
          dispatchMessageId: dispatch.dispatchMessageId,
          kind: 'final',
          heartbeatAt: now(),
          thresholdResults,
          summaryBlobRef: summaryRef,
          timeseriesBlobRef: timeseriesRef,
        });
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : 'Runner execution failed';
        try {
          await postFinalError(dispatch, detail);
        } catch {
          // Swallow secondary callback failures; entrypoint logs elsewhere.
        }
      }
    },
  };
}
