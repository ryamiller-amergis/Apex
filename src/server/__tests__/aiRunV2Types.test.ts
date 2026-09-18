import {
  AI_CONTROL_PLANE_LEASE_KEYS,
  AI_RUN_ARTIFACT_STATUSES,
  AI_RUN_TRANSPORT_VERSIONS,
  AI_RUN_V2_ACTIVE_ATTEMPT_STATUSES,
  AI_RUN_V2_ATTEMPT_STATUSES,
  AI_RUN_V2_FAILURE_CATEGORIES,
  AI_RUN_V2_SCHEMA_VERSION,
  AI_RUN_V2_TERMINAL_ATTEMPT_STATUSES,
  isAiControlPlaneLeaseKey,
  isAiRunArtifactStatus,
  isAiRunBlobRef,
  isAiRunTransportVersion,
  isAiRunV2ActiveAttemptStatus,
  isAiRunV2ArtifactManifest,
  isAiRunV2AttemptStatus,
  isAiRunV2Checkpoint,
  isAiRunV2Command,
  isAiRunV2FailureCategory,
  isAiRunV2Result,
  isAiRunV2TerminalAttemptStatus,
  type AiRunV2ArtifactManifest,
  type AiRunV2Checkpoint,
  type AiRunV2Command,
  type AiRunV2Result,
} from '../../shared/types/aiRunV2';

const blobRef = {
  container: 'ai-run-artifacts',
  key: 'runs/run-1/attempts/1/spec.json',
};

const envelopeBase = {
  schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
  eventId: 'evt-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  attemptNumber: 1,
  dispatchMessageId: 'dispatch-1',
  timestamp: '2026-09-18T12:00:00.000Z',
};

describe('AI-run V2 shared types', () => {
  it('exposes closed transport, attempt, artifact, failure, and lease vocabularies', () => {
    expect(AI_RUN_TRANSPORT_VERSIONS).toEqual([
      'http-files-v1',
      'servicebus-blob-v2',
    ]);
    expect(AI_RUN_V2_ATTEMPT_STATUSES).toEqual([
      'queued',
      'dispatched',
      'running',
      'checking_worker',
      'finalizing',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(AI_RUN_V2_ACTIVE_ATTEMPT_STATUSES).toEqual([
      'queued',
      'dispatched',
      'running',
      'checking_worker',
      'finalizing',
    ]);
    expect(AI_RUN_V2_TERMINAL_ATTEMPT_STATUSES).toEqual([
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(AI_RUN_ARTIFACT_STATUSES).toEqual([
      'pending',
      'uploading',
      'manifest_written',
      'verified',
      'failed',
    ]);
    expect(AI_RUN_V2_FAILURE_CATEGORIES).toContain('poison_message');
    expect(AI_CONTROL_PLANE_LEASE_KEYS).toEqual([
      'admission',
      'recovery',
      'reaper',
      'outbox',
    ]);

    expect(isAiRunTransportVersion('http-files-v1')).toBe(true);
    expect(isAiRunTransportVersion('servicebus-blob-v2')).toBe(true);
    expect(isAiRunTransportVersion('ftp-v0')).toBe(false);
    expect(isAiRunV2AttemptStatus('checking_worker')).toBe(true);
    expect(isAiRunV2AttemptStatus('bogus')).toBe(false);
    expect(isAiRunV2ActiveAttemptStatus('finalizing')).toBe(true);
    expect(isAiRunV2ActiveAttemptStatus('completed')).toBe(false);
    expect(isAiRunV2TerminalAttemptStatus('failed')).toBe(true);
    expect(isAiRunV2TerminalAttemptStatus('running')).toBe(false);
    expect(isAiRunArtifactStatus('verified')).toBe(true);
    expect(isAiRunArtifactStatus('done')).toBe(false);
    expect(isAiRunV2FailureCategory('artifact_verification_failed')).toBe(true);
    expect(isAiRunV2FailureCategory('unknown')).toBe(false);
    expect(isAiControlPlaneLeaseKey('outbox')).toBe(true);
    expect(isAiControlPlaneLeaseKey('watcher')).toBe(false);
  });

  it('accepts a valid dispatch command with an immutable spec reference', () => {
    const command: AiRunV2Command = {
      ...envelopeBase,
      kind: 'dispatch_command',
      transport: 'servicebus-blob-v2',
      specRef: blobRef,
    };
    expect(isAiRunV2Command(command)).toBe(true);
    expect(isAiRunBlobRef(command.specRef)).toBe(true);
  });

  it('rejects commands with unknown schema versions, kinds, or missing fences', () => {
    expect(isAiRunV2Command({
      ...envelopeBase,
      schemaVersion: 1,
      kind: 'dispatch_command',
      transport: 'servicebus-blob-v2',
      specRef: blobRef,
    })).toBe(false);
    expect(isAiRunV2Command({
      ...envelopeBase,
      kind: 'legacy_dispatch',
      transport: 'servicebus-blob-v2',
      specRef: blobRef,
    })).toBe(false);
    expect(isAiRunV2Command({
      ...envelopeBase,
      attemptNumber: 0,
      kind: 'dispatch_command',
      transport: 'servicebus-blob-v2',
      specRef: blobRef,
    })).toBe(false);
    expect(isAiRunV2Command({
      ...envelopeBase,
      dispatchMessageId: '',
      kind: 'dispatch_command',
      transport: 'servicebus-blob-v2',
      specRef: blobRef,
    })).toBe(false);
    expect(isAiRunV2Command({
      ...envelopeBase,
      kind: 'dispatch_command',
      transport: 'servicebus-blob-v2',
      specRef: { container: 'ai-run-artifacts' },
    })).toBe(false);
  });

  it('accepts started, heartbeat, and progress checkpoints with positive sequences', () => {
    const started: AiRunV2Checkpoint = {
      ...envelopeBase,
      kind: 'started',
      checkpointSequence: 1,
      containerAppsExecutionId: 'exec-1',
    };
    const heartbeat: AiRunV2Checkpoint = {
      ...envelopeBase,
      kind: 'heartbeat',
      checkpointSequence: 2,
    };
    const progress: AiRunV2Checkpoint = {
      ...envelopeBase,
      kind: 'progress',
      checkpointSequence: 3,
      phase: 'planning',
      status: 'running',
      detail: 'still working',
    };
    expect(isAiRunV2Checkpoint(started)).toBe(true);
    expect(isAiRunV2Checkpoint(heartbeat)).toBe(true);
    expect(isAiRunV2Checkpoint(progress)).toBe(true);
  });

  it('rejects checkpoints with stale schema, unknown kinds, or non-positive sequences', () => {
    expect(isAiRunV2Checkpoint({
      ...envelopeBase,
      kind: 'heartbeat',
      checkpointSequence: 0,
    })).toBe(false);
    expect(isAiRunV2Checkpoint({
      ...envelopeBase,
      kind: 'heartbeat',
      checkpointSequence: 1.5,
    })).toBe(false);
    expect(isAiRunV2Checkpoint({
      ...envelopeBase,
      kind: 'token',
      checkpointSequence: 1,
    })).toBe(false);
    expect(isAiRunV2Checkpoint({
      ...envelopeBase,
      kind: 'started',
      checkpointSequence: 1,
    })).toBe(false);
  });

  it('accepts terminal results with separate execution and artifact outcomes', () => {
    const result: AiRunV2Result = {
      ...envelopeBase,
      kind: 'terminal',
      status: 'completed',
      artifactStatus: 'verified',
      manifestRef: {
        container: 'ai-run-artifacts',
        key: 'runs/run-1/attempts/1/manifest.json',
      },
    };
    expect(isAiRunV2Result(result)).toBe(true);
  });

  it('rejects terminal results with unknown statuses or failure categories', () => {
    expect(isAiRunV2Result({
      ...envelopeBase,
      kind: 'terminal',
      status: 'running',
      artifactStatus: 'pending',
    })).toBe(false);
    expect(isAiRunV2Result({
      ...envelopeBase,
      kind: 'terminal',
      status: 'failed',
      artifactStatus: 'failed',
      failureCategory: 'not-a-category',
    })).toBe(false);
  });

  it('accepts a valid artifact manifest and rejects empty attempt fences', () => {
    const manifest: AiRunV2ArtifactManifest = {
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      transport: 'servicebus-blob-v2',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      writtenAt: '2026-09-18T12:05:00.000Z',
      files: [
        {
          path: 'design-doc-design.md',
          sha256: 'a'.repeat(64),
          sizeBytes: 12,
          ref: {
            container: 'ai-run-artifacts',
            key: 'runs/run-1/attempts/1/design-doc-design.md',
          },
        },
      ],
    };
    expect(isAiRunV2ArtifactManifest(manifest)).toBe(true);
    expect(isAiRunV2ArtifactManifest({
      ...manifest,
      attemptNumber: 0,
    })).toBe(false);
    expect(isAiRunV2ArtifactManifest({
      ...manifest,
      transport: 'http-files-v1',
    })).toBe(false);
  });
});
