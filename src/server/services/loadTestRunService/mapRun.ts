import type { LoadTestRun } from '../../../shared/types/loadTest';
import type { loadTestRuns } from '../../db/schema';

type LoadTestRunRow = typeof loadTestRuns.$inferSelect;

export function mapRunRow(row: LoadTestRunRow): LoadTestRun {
  return {
    id: row.id,
    projectId: row.projectId,
    loadTestId: row.loadTestId,
    status: row.status,
    runSource: row.runSource,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    dispatchMessageId: row.dispatchMessageId ?? null,
    cancelRequested: row.cancelRequested,
    overallResult: row.overallResult ?? null,
    thresholdResults: row.thresholdResults ?? null,
    summaryArtifactRef: row.summaryArtifactRef ?? null,
    timeseriesArtifactRef: row.timeseriesArtifactRef ?? null,
    errorDetail: row.errorDetail ?? null,
    targetKey: row.targetKey ?? null,
    executionSnapshot: row.executionSnapshot ?? null,
    requirementActivityExternalId: row.requirementActivityExternalId ?? null,
    requirementActivityPostedAt: row.requirementActivityPostedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
