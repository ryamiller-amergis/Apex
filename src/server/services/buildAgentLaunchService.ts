import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { BlobServiceClient } from '@azure/storage-blob';
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns } from '../db/schema';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type {
  BuildLaunchRefusal,
  BuildLaunchSnapshot,
} from '../../shared/types/buildLaunchSnapshot';
import { captureCloudAgentIdentity, enqueue, markTerminal } from './agentRunLifecycleService';
import {
  createSecretValueDetector,
  validateBuildLaunchSnapshot,
  type SecretValueDetector,
} from './buildExecutionSnapshot';
import { defaultKnownSecrets } from './buildRedactionService';
import { resolveCloudAgentRunLimitMs } from './cloudAgentQueue';
import {
  cancelCursorCloudAgentRun,
  launchCloudAgent,
  type LaunchCloudAgentResult,
} from './cursorCloudAgentClient';
import { CURSOR_PROMPT_CONTAINER, resolveCursorPromptBlobAccount } from './cursorPromptStore';
import { trackEvent } from './telemetry';

/** Same window My Work gives a row that has no Cursor identity yet. */
export const BUILD_AGENT_PRE_IDENTITY_TTL_MS = 2 * 60_000;
/** Build prompts and context share the cursor-prompts container under this prefix. */
export const BUILD_PROMPT_KEY_PREFIX = 'builds/';

const UNIQUE_VIOLATION = '23505';
const INTEGRITY_VIOLATION = '23000';
const ONE_LIVE_PER_BUILD_TASK = 'uq_agent_runs_one_live_per_build_task';

export interface BlobLocation {
  container: string;
  key: string;
}

export interface BuildAgentLaunchDeps {
  detector: SecretValueDetector;
  readBlobText(pointer: BlobLocation): Promise<string>;
}

export type WriteBuildLaunchSnapshotResult =
  | { ok: true; runId: string }
  | { ok: false; refused: true; refusals: BuildLaunchRefusal[] }
  | { ok: false; conflict: true; reason: 'task_already_launching' | 'snapshot_already_written' };

export type LaunchBuildAgentRunResult =
  | { ok: true; runId: string; cloudAgentId: string; cursorRunId: string }
  | { ok: false; refused: true; refusals: BuildLaunchRefusal[] }
  | { ok: false; conflict: true; reason: string };

export function defaultBuildAgentLaunchDeps(): BuildAgentLaunchDeps {
  return {
    detector: createSecretValueDetector(defaultKnownSecrets()),
    readBlobText: readBuildPromptBlob,
  };
}

/** Reads build prompt text from the shared cursor-prompts container. */
export async function readBuildPromptBlob(pointer: BlobLocation): Promise<string> {
  const container = process.env.CURSOR_PROMPT_BLOB_CONTAINER_NAME?.trim() || CURSOR_PROMPT_CONTAINER;
  if (pointer.container !== container || !pointer.key.startsWith(BUILD_PROMPT_KEY_PREFIX)) {
    throw new Error('Build prompt pointer is outside the build prompt area.');
  }
  const accountName = resolveCursorPromptBlobAccount();
  const credential = process.env.NODE_ENV === 'production'
    ? new ManagedIdentityCredential()
    : new AzureCliCredential();
  const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  const body = await service.getContainerClient(container).getBlobClient(pointer.key).downloadToBuffer();
  return body.toString('utf8');
}

function buildAgentInstanceId(): string {
  return process.env.WEBSITE_INSTANCE_ID?.trim() || 'apex-build-agent';
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errorCode(err: unknown): { code?: string; constraint?: string } {
  if (!err || typeof err !== 'object') return {};
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return {
    code: typeof code === 'string' ? code : undefined,
    constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

/** Telemetry label from untrusted input: empty unless it is a short string with no secret. */
function safeLabel(value: unknown, detector: SecretValueDetector): string {
  if (typeof value !== 'string' || value.length > 200 || detector.containsSecret(value)) return '';
  return value;
}

interface RunLabels {
  buildRunId: string;
  taskKey: string;
}

function labelsFrom(candidate: unknown, detector: SecretValueDetector): RunLabels {
  const record = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  return {
    buildRunId: safeLabel(record.buildRunId, detector),
    taskKey: safeLabel(record.taskKey, detector),
  };
}

function trackRefusals(labels: RunLabels, refusals: BuildLaunchRefusal[]): void {
  for (const refusal of refusals) {
    trackEvent('build_agent.launch_refused', {
      ...labels,
      code: refusal.code,
      fieldPath: refusal.fieldPath ?? '',
    });
  }
}

function refusalDetail(refusals: BuildLaunchRefusal[]): string {
  const reasons = refusals.map((refusal) => (
    refusal.fieldPath ? `${refusal.code} (${refusal.fieldPath})` : refusal.code
  ));
  return `Build agent launch refused: ${reasons.join(', ')}.`;
}

function executionStub(snapshot: BuildLaunchSnapshot, projectId: string): ExecutionSnapshot {
  return {
    prompt: `build-task:${snapshot.buildTaskId}`,
    model: snapshot.model,
    workspaceRef: snapshot.buildTaskId,
    workflowClass: 'build-task',
    skillPath: snapshot.skill.path,
    projectId,
    threadId: snapshot.buildTaskId,
  };
}

class SnapshotAlreadyWrittenError extends Error {}

/**
 * Validates the candidate, then inserts the agent run and its snapshot in one
 * transaction. Nothing here calls Cursor. Pass `runId` to retry a write
 * idempotently: the same snapshot succeeds, a different one is refused.
 */
export async function writeBuildLaunchSnapshot(input: {
  candidate: unknown;
  expectedProjectId: string;
  runId?: string;
  deps?: Pick<BuildAgentLaunchDeps, 'detector'>;
}): Promise<WriteBuildLaunchSnapshotResult> {
  const startedMs = Date.now();
  const detector = input.deps?.detector ?? defaultBuildAgentLaunchDeps().detector;
  const validation = validateBuildLaunchSnapshot(input.candidate, {
    expectedProjectId: input.expectedProjectId,
    detector,
  });
  if (!validation.ok) {
    trackRefusals(labelsFrom(input.candidate, detector), validation.refusals);
    return { ok: false, refused: true, refusals: validation.refusals };
  }
  const { snapshot } = validation;

  if (input.runId) {
    const existing = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, input.runId),
      columns: { id: true, buildLaunchSnapshot: true },
    });
    if (existing) {
      return isDeepStrictEqual(existing.buildLaunchSnapshot, snapshot)
        ? { ok: true, runId: existing.id }
        : { ok: false, conflict: true, reason: 'snapshot_already_written' };
    }
  }

  try {
    const runId = await db.transaction(async (tx) => {
      const { runId: insertedId } = await enqueue({
        ...(input.runId ? { runId: input.runId } : {}),
        threadId: snapshot.buildTaskId,
        projectId: input.expectedProjectId,
        timeoutAt: new Date(Date.now() + BUILD_AGENT_PRE_IDENTITY_TTL_MS).toISOString(),
        lane: 'cloud-agent',
        ownerInstance: buildAgentInstanceId(),
        buildTaskId: snapshot.buildTaskId,
        workflowClass: 'build-task',
        snapshot: executionStub(snapshot, input.expectedProjectId),
        executor: tx,
      });
      const written = await tx
        .update(agentRuns)
        .set({ buildLaunchSnapshot: snapshot })
        .where(and(
          eq(agentRuns.id, insertedId),
          sql`${agentRuns.buildLaunchSnapshot} IS NULL`,
        ))
        .returning({ id: agentRuns.id });
      if (written.length === 0) throw new SnapshotAlreadyWrittenError();
      return insertedId;
    });

    trackEvent('build_agent.snapshot_written', {
      buildRunId: snapshot.buildRunId,
      taskKey: snapshot.taskKey,
      role: snapshot.role,
      attempt: String(snapshot.attempt),
    }, { durationMs: Date.now() - startedMs });
    return { ok: true, runId };
  } catch (err) {
    if (err instanceof SnapshotAlreadyWrittenError) {
      return { ok: false, conflict: true, reason: 'snapshot_already_written' };
    }
    const { code, constraint } = errorCode(err);
    if (code === UNIQUE_VIOLATION && constraint === ONE_LIVE_PER_BUILD_TASK) {
      return { ok: false, conflict: true, reason: 'task_already_launching' };
    }
    if (code === UNIQUE_VIOLATION || code === INTEGRITY_VIOLATION) {
      return { ok: false, conflict: true, reason: 'snapshot_already_written' };
    }
    throw err;
  }
}

async function refuseLaunch(
  runId: string,
  labels: RunLabels,
  refusals: BuildLaunchRefusal[],
): Promise<LaunchBuildAgentRunResult> {
  trackRefusals(labels, refusals);
  const terminal = await markTerminal(runId, { status: 'failed', detail: refusalDetail(refusals) });
  if (!terminal.ok) {
    console.error('[build-agent] could not record launch refusal', JSON.stringify({
      runId,
      reason: terminal.reason,
    }));
  }
  return { ok: false, refused: true, refusals };
}

async function failLaunch(
  runId: string,
  labels: RunLabels,
  reason: string,
  detail: string,
  options: { orphanStopped: boolean; dispatchMessageId?: string },
): Promise<LaunchBuildAgentRunResult> {
  trackEvent('build_agent.launch_failed', {
    ...labels,
    runId,
    reason,
    orphanStopped: String(options.orphanStopped),
  });
  const terminal = await markTerminal(runId, {
    status: 'failed',
    detail,
    ...(options.dispatchMessageId ? { dispatchMessageId: options.dispatchMessageId } : {}),
  });
  if (!terminal.ok) {
    console.error('[build-agent] could not record launch failure', JSON.stringify({
      runId,
      reason: terminal.reason,
    }));
  }
  return { ok: false, conflict: true, reason };
}

/** A paid agent must not run untracked. Returns whether Cursor accepted the stop. */
async function stopUntrackedAgent(
  project: string,
  launched: LaunchCloudAgentResult,
  runId: string,
): Promise<boolean> {
  try {
    await cancelCursorCloudAgentRun({
      project,
      cloudAgentId: launched.cloudAgentId,
      cursorRunId: launched.cursorRunId,
    });
    return true;
  } catch (err) {
    console.error('[build-agent] could not stop an agent that was not recorded', JSON.stringify({
      runId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
}

/**
 * Launches one queued build agent run from its stored snapshot only. Refuses
 * before any Cursor call when the snapshot or the prompt it points at fails a
 * check, and marks the row failed so no queued row lingers.
 */
export async function launchBuildAgentRun(
  runId: string,
  deps: BuildAgentLaunchDeps = defaultBuildAgentLaunchDeps(),
): Promise<LaunchBuildAgentRunResult> {
  const row = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, runId) });
  if (!row) return { ok: false, conflict: true, reason: 'run_not_found' };
  if (row.workflowClass !== 'build-task' || !row.buildTaskId || !row.projectId) {
    return { ok: false, conflict: true, reason: 'not_a_build_run' };
  }
  if (row.status !== 'queued' || row.cloudAgentIdentity) {
    return { ok: false, conflict: true, reason: 'run_not_launchable' };
  }

  const validation = validateBuildLaunchSnapshot(row.buildLaunchSnapshot, {
    expectedProjectId: row.projectId,
    detector: deps.detector,
  });
  if (!validation.ok) {
    return refuseLaunch(runId, labelsFrom(row.buildLaunchSnapshot, deps.detector), validation.refusals);
  }
  const { snapshot } = validation;
  const labels: RunLabels = { buildRunId: snapshot.buildRunId, taskKey: snapshot.taskKey };
  if (snapshot.buildTaskId !== row.buildTaskId) {
    return refuseLaunch(runId, labels, [{ code: 'snapshot_field_invalid', fieldPath: 'buildTaskId' }]);
  }

  let prompt: string;
  try {
    prompt = await deps.readBlobText({ container: snapshot.prompt.container, key: snapshot.prompt.key });
  } catch {
    return failLaunch(runId, labels, 'prompt_unavailable', 'Build agent launch failed: the prompt could not be read.', {
      orphanStopped: false,
    });
  }
  if (sha256Hex(prompt) !== snapshot.prompt.contentHash) {
    return refuseLaunch(runId, labels, [{ code: 'prompt_hash_mismatch', fieldPath: 'prompt.contentHash' }]);
  }
  if (deps.detector.containsHeldSecretValue(prompt)) {
    return refuseLaunch(runId, labels, [{ code: 'prompt_contains_held_secret', fieldPath: 'prompt' }]);
  }

  const launchStartedMs = Date.now();
  let launched: LaunchCloudAgentResult;
  try {
    launched = await launchCloudAgent({
      project: snapshot.repository.project,
      prompt,
      model: snapshot.model,
      skillProvider: snapshot.repository.provider,
      skillRepo: snapshot.repository.repo,
      workItemTitle: `${snapshot.buildRunId.slice(0, 8)}/${snapshot.taskKey}`,
      build: {
        startingBranch: snapshot.startingBranch,
        branchName: snapshot.targetBranch,
        openPullRequest: snapshot.pullRequest.open,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Build agent launch failed.';
    return failLaunch(runId, labels, 'launch_failed', detail, { orphanStopped: false });
  }

  const timeoutAt = new Date(
    Date.now() + Math.min(snapshot.caps.elapsedMs, resolveCloudAgentRunLimitMs()),
  ).toISOString();
  let captureFailure: string;
  let recorded: { cloudAgentIdentity?: string | null; dispatchMessageId?: string | null } | null = null;
  try {
    const captured = await captureCloudAgentIdentity(runId, {
      cloudAgentIdentity: launched.cloudAgentId,
      cursorRunId: launched.cursorRunId,
      jobName: launched.jobName,
      branchName: snapshot.targetBranch,
      timeoutAt,
    });
    const alreadyOurs = !captured.ok
      && captured.reason === 'identity_already_set'
      && captured.run?.cloudAgentIdentity === launched.cloudAgentId;
    if (captured.ok || alreadyOurs) {
      trackEvent('build_agent.launched', {
        ...labels,
        role: snapshot.role,
        runId,
      }, { launchMs: Date.now() - launchStartedMs });
      return { ok: true, runId, cloudAgentId: launched.cloudAgentId, cursorRunId: launched.cursorRunId };
    }
    captureFailure = captured.reason;
    recorded = captured.run;
  } catch (err) {
    captureFailure = err instanceof Error ? err.message : 'identity_capture_failed';
    recorded = (await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, runId),
      columns: { cloudAgentIdentity: true, dispatchMessageId: true },
    })) ?? null;
  }

  const orphanStopped = await stopUntrackedAgent(snapshot.repository.project, launched, runId);
  if (captureFailure === 'run_cancelled') {
    trackEvent('build_agent.launch_failed', {
      ...labels,
      runId,
      reason: captureFailure,
      orphanStopped: String(orphanStopped),
    });
    return { ok: false, conflict: true, reason: captureFailure };
  }
  // Identity capture writes the fence before the queued → running move, so markTerminal must present it.
  const ours = recorded?.cloudAgentIdentity === launched.cloudAgentId
    || recorded?.dispatchMessageId === launched.cursorRunId;
  return failLaunch(runId, labels, 'identity_capture_failed', 'Build agent launch failed: the Cursor agent could not be recorded.', {
    orphanStopped,
    dispatchMessageId: ours ? (recorded?.dispatchMessageId ?? launched.cursorRunId) : undefined,
  });
}
