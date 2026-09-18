/**
 * Durable AI-run V2 wire contracts and persistence vocabulary.
 *
 * Task 3 defines the closed enums and envelopes only. V1 HTTP/Files transport
 * remains the live path until Task 8 cutover.
 */

export const AI_RUN_V2_SCHEMA_VERSION = 2 as const;

export const AI_RUN_TRANSPORT_VERSIONS = [
  'http-files-v1',
  'servicebus-blob-v2',
] as const;
export type AiRunTransportVersion = (typeof AI_RUN_TRANSPORT_VERSIONS)[number];

/** Attempt-local execution statuses. Header `agent_runs.status` stays V1 until Task 5. */
export const AI_RUN_V2_ATTEMPT_STATUSES = [
  'queued',
  'dispatched',
  'running',
  'checking_worker',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AiRunV2AttemptStatus = (typeof AI_RUN_V2_ATTEMPT_STATUSES)[number];

export const AI_RUN_V2_ACTIVE_ATTEMPT_STATUSES = [
  'queued',
  'dispatched',
  'running',
  'checking_worker',
  'finalizing',
] as const;
export type AiRunV2ActiveAttemptStatus =
  (typeof AI_RUN_V2_ACTIVE_ATTEMPT_STATUSES)[number];

export const AI_RUN_V2_TERMINAL_ATTEMPT_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const;
export type AiRunV2TerminalAttemptStatus =
  (typeof AI_RUN_V2_TERMINAL_ATTEMPT_STATUSES)[number];

export const AI_RUN_ARTIFACT_STATUSES = [
  'pending',
  'uploading',
  'manifest_written',
  'verified',
  'failed',
] as const;
export type AiRunArtifactStatus = (typeof AI_RUN_ARTIFACT_STATUSES)[number];

export const AI_RUN_V2_FAILURE_CATEGORIES = [
  'worker_lost',
  'progress_timeout',
  'queue_ttl',
  'dispatch_ttl',
  'forced_cancel',
  'poison_message',
  'artifact_verification_failed',
  'lease_lost',
  'internal_error',
] as const;
export type AiRunV2FailureCategory =
  (typeof AI_RUN_V2_FAILURE_CATEGORIES)[number];

export const AI_RUN_V2_COMMAND_KINDS = ['dispatch_command'] as const;
export type AiRunV2CommandKind = (typeof AI_RUN_V2_COMMAND_KINDS)[number];

export const AI_RUN_V2_CHECKPOINT_KINDS = [
  'started',
  'heartbeat',
  'progress',
] as const;
export type AiRunV2CheckpointKind = (typeof AI_RUN_V2_CHECKPOINT_KINDS)[number];

export const AI_RUN_V2_RESULT_KINDS = ['terminal'] as const;
export type AiRunV2ResultKind = (typeof AI_RUN_V2_RESULT_KINDS)[number];

export const AI_CONTROL_PLANE_LEASE_KEYS = [
  'admission',
  'recovery',
  'reaper',
  'outbox',
] as const;
export type AiControlPlaneLeaseKey =
  (typeof AI_CONTROL_PLANE_LEASE_KEYS)[number];

export type AiRunBlobRef = Readonly<{
  container: string;
  key: string;
}>;

type AiRunV2EnvelopeBase = Readonly<{
  schemaVersion: typeof AI_RUN_V2_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
  timestamp: string;
}>;

export type AiRunV2Command = AiRunV2EnvelopeBase &
  Readonly<{
    kind: 'dispatch_command';
    transport: 'servicebus-blob-v2';
    specRef: AiRunBlobRef;
  }>;

export type AiRunV2StartedCheckpoint = AiRunV2EnvelopeBase &
  Readonly<{
    kind: 'started';
    checkpointSequence: number;
    containerAppsExecutionId: string;
  }>;

export type AiRunV2HeartbeatCheckpoint = AiRunV2EnvelopeBase &
  Readonly<{
    kind: 'heartbeat';
    checkpointSequence: number;
  }>;

export type AiRunV2ProgressCheckpoint = AiRunV2EnvelopeBase &
  Readonly<{
    kind: 'progress';
    checkpointSequence: number;
    phase: string;
    status: string;
    detail?: string;
  }>;

export type AiRunV2Checkpoint =
  | AiRunV2StartedCheckpoint
  | AiRunV2HeartbeatCheckpoint
  | AiRunV2ProgressCheckpoint;

export type AiRunV2TerminalResult = AiRunV2EnvelopeBase &
  Readonly<{
    kind: 'terminal';
    status: AiRunV2TerminalAttemptStatus;
    artifactStatus: AiRunArtifactStatus;
    failureCategory?: AiRunV2FailureCategory;
    detail?: string;
    manifestRef?: AiRunBlobRef;
  }>;

export type AiRunV2Result = AiRunV2TerminalResult;

export type AiRunV2ArtifactManifestEntry = Readonly<{
  path: string;
  sha256: string;
  sizeBytes: number;
  ref: AiRunBlobRef;
}>;

export type AiRunV2ArtifactManifest = Readonly<{
  schemaVersion: typeof AI_RUN_V2_SCHEMA_VERSION;
  transport: 'servicebus-blob-v2';
  runId: string;
  attemptId: string;
  attemptNumber: number;
  files: ReadonlyArray<AiRunV2ArtifactManifestEntry>;
  writtenAt: string;
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isAiRunTransportVersion(
  value: unknown
): value is AiRunTransportVersion {
  return (
    typeof value === 'string' &&
    (AI_RUN_TRANSPORT_VERSIONS as readonly string[]).includes(value)
  );
}

export function isAiRunV2AttemptStatus(
  value: unknown
): value is AiRunV2AttemptStatus {
  return (
    typeof value === 'string' &&
    (AI_RUN_V2_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

export function isAiRunV2ActiveAttemptStatus(
  value: unknown
): value is AiRunV2ActiveAttemptStatus {
  return (
    typeof value === 'string' &&
    (AI_RUN_V2_ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

export function isAiRunV2TerminalAttemptStatus(
  value: unknown
): value is AiRunV2TerminalAttemptStatus {
  return (
    typeof value === 'string' &&
    (AI_RUN_V2_TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

export function isAiRunArtifactStatus(
  value: unknown
): value is AiRunArtifactStatus {
  return (
    typeof value === 'string' &&
    (AI_RUN_ARTIFACT_STATUSES as readonly string[]).includes(value)
  );
}

export function isAiRunV2FailureCategory(
  value: unknown
): value is AiRunV2FailureCategory {
  return (
    typeof value === 'string' &&
    (AI_RUN_V2_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isAiControlPlaneLeaseKey(
  value: unknown
): value is AiControlPlaneLeaseKey {
  return (
    typeof value === 'string' &&
    (AI_CONTROL_PLANE_LEASE_KEYS as readonly string[]).includes(value)
  );
}

export function isAiRunBlobRef(value: unknown): value is AiRunBlobRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.container) && isNonEmptyString(candidate.key)
  );
}

function hasEnvelopeBase(value: unknown): value is AiRunV2EnvelopeBase {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === AI_RUN_V2_SCHEMA_VERSION &&
    isNonEmptyString(candidate.eventId) &&
    isNonEmptyString(candidate.runId) &&
    isNonEmptyString(candidate.attemptId) &&
    isPositiveInteger(candidate.attemptNumber) &&
    isNonEmptyString(candidate.dispatchMessageId) &&
    isNonEmptyString(candidate.timestamp)
  );
}

export function isAiRunV2Command(value: unknown): value is AiRunV2Command {
  if (!hasEnvelopeBase(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === 'dispatch_command' &&
    candidate.transport === 'servicebus-blob-v2' &&
    isAiRunBlobRef(candidate.specRef)
  );
}

export function isAiRunV2Checkpoint(
  value: unknown
): value is AiRunV2Checkpoint {
  if (!hasEnvelopeBase(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isPositiveInteger(candidate.checkpointSequence)) return false;
  if (candidate.kind === 'started') {
    return isNonEmptyString(candidate.containerAppsExecutionId);
  }
  if (candidate.kind === 'heartbeat') {
    return true;
  }
  if (candidate.kind === 'progress') {
    return (
      isNonEmptyString(candidate.phase) && isNonEmptyString(candidate.status)
    );
  }
  return false;
}

export function isAiRunV2Result(value: unknown): value is AiRunV2Result {
  if (!hasEnvelopeBase(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'terminal') return false;
  if (!isAiRunV2TerminalAttemptStatus(candidate.status)) return false;
  if (!isAiRunArtifactStatus(candidate.artifactStatus)) return false;
  if (
    candidate.failureCategory !== undefined &&
    !isAiRunV2FailureCategory(candidate.failureCategory)
  ) {
    return false;
  }
  if (
    candidate.manifestRef !== undefined &&
    !isAiRunBlobRef(candidate.manifestRef)
  ) {
    return false;
  }
  if (candidate.detail !== undefined && typeof candidate.detail !== 'string') {
    return false;
  }
  return true;
}

export function isAiRunV2ArtifactManifest(
  value: unknown
): value is AiRunV2ArtifactManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== AI_RUN_V2_SCHEMA_VERSION) return false;
  if (candidate.transport !== 'servicebus-blob-v2') return false;
  if (!isNonEmptyString(candidate.runId)) return false;
  if (!isNonEmptyString(candidate.attemptId)) return false;
  if (!isPositiveInteger(candidate.attemptNumber)) return false;
  if (!isNonEmptyString(candidate.writtenAt)) return false;
  if (!Array.isArray(candidate.files)) return false;
  return candidate.files.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const file = entry as Record<string, unknown>;
    return (
      isNonEmptyString(file.path) &&
      isNonEmptyString(file.sha256) &&
      isNonNegativeInteger(file.sizeBytes) &&
      isAiRunBlobRef(file.ref)
    );
  });
}
