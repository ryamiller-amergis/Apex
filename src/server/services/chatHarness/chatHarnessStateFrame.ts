/**
 * Text-free `HarnessThreadState` frame builder and loader.
 *
 * State frames carry only thread status, active run id, phase, harness area,
 * pending command ids/statuses, and latest summary metadata — never message
 * text, command payloads, or summary text.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chatThreads } from '../../db/schema';
import type { ChatThreadStatus } from '../../../shared/types/chat';
import {
  isHarnessAgentPhase,
  isHarnessAreaId,
  type HarnessAgentPhase,
  type HarnessAreaId,
  type HarnessPendingCommand,
  type HarnessSummaryMarker,
  type HarnessThreadState,
} from '../../../shared/types/chatHarness';
import { chatHarnessCommandRepository } from './chatHarnessCommandRepository';
import { getLatestSummaryMarker } from './chatHarnessSummaryStore';

export interface ThreadStateSourceRow {
  status: ChatThreadStatus;
  activeRunId?: string | null;
  harnessArea?: HarnessAreaId | string | null;
}

export interface BuildHarnessThreadStateInput {
  thread: ThreadStateSourceRow;
  pendingCommands: ReadonlyArray<HarnessPendingCommand>;
  latestSummary: HarnessSummaryMarker | null;
  /** Explicit phase override (e.g. from live run phase events). */
  phase?: HarnessAgentPhase | null;
  /** Optional hint when the active run is a summarize operation. */
  activeRunOperation?: 'summarize' | null;
  /** Optional hint for active run lifecycle status when `phase` is omitted. */
  activeRunStatus?: 'queued' | 'dispatched' | 'running' | null;
  canWrite?: boolean;
}

function derivePhase(input: BuildHarnessThreadStateInput): HarnessAgentPhase {
  if (input.phase && isHarnessAgentPhase(input.phase)) {
    return input.phase;
  }
  const activeRunId = input.thread.activeRunId ?? null;
  if (!activeRunId || input.thread.status !== 'running') {
    return 'idle';
  }
  if (
    input.activeRunOperation === 'summarize' ||
    input.pendingCommands.some(
      (cmd) => cmd.kind === 'summarize' && cmd.status === 'accepted',
    )
  ) {
    return 'summarizing';
  }
  if (
    input.activeRunStatus === 'queued' ||
    input.activeRunStatus === 'dispatched'
  ) {
    return 'starting';
  }
  return 'running';
}

/**
 * Assemble a strictly text-free `HarnessThreadState` frame from thread metadata,
 * pending commands, and latest summary marker.
 */
export function buildHarnessThreadState(
  input: BuildHarnessThreadStateInput,
): HarnessThreadState {
  const harnessArea: HarnessAreaId | null = isHarnessAreaId(
    input.thread.harnessArea,
  )
    ? input.thread.harnessArea
    : null;

  const latestSummary: HarnessSummaryMarker | null = input.latestSummary
    ? {
        id: input.latestSummary.id,
        source: input.latestSummary.source,
        fallback: input.latestSummary.fallback,
        createdAt: input.latestSummary.createdAt,
      }
    : null;

  const pendingCommands: HarnessPendingCommand[] = input.pendingCommands.map(
    (cmd) => ({
      commandId: cmd.commandId,
      kind: cmd.kind,
      status: cmd.status,
    }),
  );

  return {
    threadStatus: input.thread.status,
    activeRunId: input.thread.activeRunId ?? null,
    phase: derivePhase(input),
    harnessArea,
    pendingCommands,
    latestSummary,
    ...(input.canWrite !== undefined ? { canWrite: input.canWrite } : {}),
  };
}

export interface LoadHarnessThreadStateDeps {
  loadThreadSummaryRow?: (
    threadId: string,
  ) => Promise<ThreadStateSourceRow | null>;
  listPendingCommands?: (threadId: string) => Promise<HarnessPendingCommand[]>;
  getLatestSummaryMarker?: (
    threadId: string,
  ) => Promise<HarnessSummaryMarker | null>;
}

async function defaultLoadThreadSummaryRow(
  threadId: string,
): Promise<ThreadStateSourceRow | null> {
  const rows = await db
    .select({
      status: chatThreads.status,
      activeRunId: chatThreads.activeRunId,
      harnessArea: chatThreads.harnessArea,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status as ChatThreadStatus,
    activeRunId: row.activeRunId ?? null,
    harnessArea: row.harnessArea ?? null,
  };
}

/**
 * Load thread state, pending commands, and latest summary marker for a thread
 * without selecting message text, command payloads, or summary text.
 */
export async function loadHarnessThreadState(
  threadId: string,
  deps?: LoadHarnessThreadStateDeps,
  options?: {
    phase?: HarnessAgentPhase | null;
    activeRunOperation?: 'summarize' | null;
    activeRunStatus?: 'queued' | 'dispatched' | 'running' | null;
    canWrite?: boolean;
  },
): Promise<HarnessThreadState | null> {
  const loadThread = deps?.loadThreadSummaryRow ?? defaultLoadThreadSummaryRow;
  const loadPending =
    deps?.listPendingCommands ??
    ((id: string) => chatHarnessCommandRepository.listPendingCommands(id));
  const loadSummary = deps?.getLatestSummaryMarker ?? getLatestSummaryMarker;

  const thread = await loadThread(threadId);
  if (!thread) return null;

  const [pendingCommands, latestSummary] = await Promise.all([
    loadPending(threadId),
    loadSummary(threadId),
  ]);

  return buildHarnessThreadState({
    thread,
    pendingCommands,
    latestSummary,
    phase: options?.phase,
    activeRunOperation: options?.activeRunOperation,
    activeRunStatus: options?.activeRunStatus,
    canWrite: options?.canWrite,
  });
}
