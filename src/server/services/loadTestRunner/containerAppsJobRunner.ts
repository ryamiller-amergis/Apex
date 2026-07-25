import type {
  ArtifactRef,
  LoadTestDispatchMessage,
  LoadTestRunner,
  LoadTestRunIngestBody,
  LoadProfileStage,
} from '../../../shared/types/loadTest';
import { buildLoadTestArtifactKey } from './artifactKey';
import { mapK6ThresholdResults } from './thresholdMapper';

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
};

function metricOnlySummary(summary: unknown): string {
  // Strip anything that could look like response bodies; keep metrics only.
  const safe =
    summary && typeof summary === 'object'
      ? { metrics: (summary as { metrics?: unknown }).metrics ?? {} }
      : { metrics: {} };
  return JSON.stringify(safe);
}

/**
 * v1 LoadTestRunner implementation for Azure Container Apps Jobs.
 */
export function createContainerAppsJobRunner(
  deps: LoadTestRunnerDeps,
): LoadTestRunner {
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

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
  ): Promise<void> {
    await deps.postIngest(dispatch.projectId, dispatch.runId, {
      dispatchMessageId: dispatch.dispatchMessageId,
      kind: 'final',
      heartbeatAt: now(),
      errorDetail,
      thresholdResults: [],
    });
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
        let cancelled = false;

        if (stages) {
          for (let i = 0; i < stages.length; i++) {
            const cancelAtBoundary = await postProgress(dispatch, {
              message: `stage-boundary:${i}`,
              vu: stages[i].target,
            });
            if (cancelAtBoundary) {
              cancelled = true;
              break;
            }

            const result = await deps.runK6({
              script: dispatch.script,
              env: { ...secretEnv, TARGET_URL: dispatch.targetUrl },
              targetUrl: dispatch.targetUrl,
              loadProfile: dispatch.loadProfile,
              clientThresholds: dispatch.clientThresholds,
              stages: [stages[i]],
              stageIndex: i,
            });
            lastSummary = result.summary;
            lastTimeseries = result.timeseries;
          }
        } else {
          const cancelBefore = await postProgress(dispatch, {
            message: 'starting-k6',
          });
          if (cancelBefore) {
            cancelled = true;
          } else {
            const result = await deps.runK6({
              script: dispatch.script,
              env: { ...secretEnv, TARGET_URL: dispatch.targetUrl },
              targetUrl: dispatch.targetUrl,
              loadProfile: dispatch.loadProfile,
              clientThresholds: dispatch.clientThresholds,
            });
            lastSummary = result.summary;
            lastTimeseries = result.timeseries;

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

        const thresholdResults = mapK6ThresholdResults(
          dispatch.clientThresholds,
          lastSummary as Parameters<typeof mapK6ThresholdResults>[1],
        );

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
