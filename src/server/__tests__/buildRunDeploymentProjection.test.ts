/**
 * buildRunDeploymentProjection tests.
 */
jest.mock('../services/buildPreviewLeaseService', () => ({
  defaultPreviewLeaseService: {
    getActiveLease: jest.fn(async () => ({
      project: 'Apex',
      repository: 'demo',
      buildRunId: 'run-1',
      buildRevisionId: 'rev-1',
      grantedAt: '2026-11-01T11:30:00.000Z',
      expiresAt: '2026-11-02T11:30:00.000Z',
    })),
    getQueuePosition: jest.fn(async () => null),
  },
}));

import { projectBuildDeploymentFields } from '../services/buildRunDeploymentProjection';
import type { ProjectionRunRow } from '../services/buildRunProjectionService';

describe('projectBuildDeploymentFields', () => {
  it('marks the leased preview as live and allows support contacts to retry', async () => {
    const run: ProjectionRunRow = {
      id: 'run-1',
      project: 'Apex',
      repository: 'demo',
      status: 'preview_ready',
      suspendReason: null,
      interviewId: null,
      currentRevisionNumber: 1,
      revisionsUsed: 1,
      revisionCap: 3,
      supportContacts: [{ userId: 'u-1', displayName: 'Dana', email: 'dana@example.com' }],
      costCapUsd: '10',
      costUsedUsd: '1',
      elapsedCapSeconds: 3600,
      parallelismCap: 2,
      parallelismUsed: 1,
      endedAt: null,
      createdAt: '2026-11-01T10:00:00.000Z',
      revisions: [
        {
          id: 'rev-1',
          revisionNumber: 1,
          requirements: [],
          assumptions: [],
          exclusions: [],
          riskDecisions: [],
          classification: 'small',
          repairAttempts: 0,
          elapsedSecondsUsed: 0,
          validatedCommit: 'a'.repeat(40),
          deploymentStatus: 'succeeded',
          deploymentQueuedAt: '2026-11-01T11:00:00.000Z',
          deployedAt: '2026-11-01T11:30:00.000Z',
          deploymentFailedStage: null,
          deploymentPipelineUrl: null,
          previewUrl: 'https://apex.example/preview',
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ],
    };

    const projected = await projectBuildDeploymentFields({
      run,
      currentRevision: run.revisions[0]!,
      viewer: { userId: 'u-1', isProjectAdmin: false, isSuperAdmin: false },
    });

    expect(projected.lease.state).toBe('held');
    expect(projected.previews[0]?.isLive).toBe(true);
    expect(projected.previews[0]?.previewUrl).toBe('https://apex.example/preview');
    expect(projected.viewer?.canRetryDeployment).toBe(true);
  });
});
