import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRunEvents, agentRuns, brainstormMessages, brainstormSessions, chatMessages } from '../db/schema';
import {
  BRAINSTORM_FAILURE_SUMMARIES,
  type BrainstormActivityItem,
  type BrainstormFailureCode,
  type BrainstormMessageDto,
  type BrainstormMessageStatus,
} from '../../shared/types/brainstorm';
import type { AiRunV2FailureCategory } from '../../shared/types/aiRunV2';
import { computeCost, recordAiUsage } from './aiUsageService';
import { brainstormUsageCtx } from './artifactUsageContext';
import { trackEvent } from './telemetry';

export type BrainstormMessageRow = typeof brainstormMessages.$inferSelect;

export class BrainstormLedgerConflict extends Error {
  constructor(readonly code: 'turn_in_progress') {
    super(code);
  }
}

const ONE_STREAMING_INDEX = 'uq_brainstorm_messages_one_streaming';
const TURN_ROLE_INDEX = 'uq_brainstorm_messages_session_turn_role';

function uniqueViolation(err: unknown): string | null {
  const record = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const source = record?.code === '23505' ? record : record?.cause?.code === '23505' ? record.cause : null;
  return source ? source.constraint ?? '' : null;
}

export function toBrainstormMessageDto(
  row: BrainstormMessageRow,
  activity?: BrainstormActivityItem[],
): BrainstormMessageDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    runId: row.runId,
    turnId: row.turnId,
    failureCode: row.failureCode,
    failureSummary: row.failureSummary,
    retryOfMessageId: row.retryOfMessageId,
    supersededByMessageId: row.supersededByMessageId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    ...(activity && activity.length > 0 ? { activity } : {}),
  };
}

function readToolTarget(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as { target?: unknown; args?: unknown };
  if (typeof record.target === 'string' && record.target.trim()) {
    return record.target.trim();
  }
  return record.args ? readToolTarget(record.args) : null;
}

function joinThinkingChunk(previous: string, next: string): string {
  if (!previous) return next;
  if (/^[.,!?;:)'"\]]/.test(next) || /\s$/.test(previous) || /^\s/.test(next)) {
    return `${previous}${next}`;
  }
  return `${previous} ${next}`;
}

export function buildBrainstormActivityFromEvents(
  events: ReadonlyArray<{ eventId: string; event: unknown }>,
): BrainstormActivityItem[] {
  const items: BrainstormActivityItem[] = [];
  const toolIndexByCallId = new Map<string, number>();

  for (const row of events) {
    if (!row.event || typeof row.event !== 'object') continue;
    const ev = row.event as {
      type?: unknown;
      text?: unknown;
      toolName?: unknown;
      callId?: unknown;
      status?: unknown;
      args?: unknown;
      result?: unknown;
    };
    if (ev.type === 'thinking' && typeof ev.text === 'string') {
      const trimmed = ev.text.trim();
      if (!trimmed || trimmed === 'Analyzing') continue;
      const last = items[items.length - 1];
      if (last && last.kind === 'thinking') {
        last.text = joinThinkingChunk(last.text ?? '', trimmed);
      } else {
        items.push({ id: row.eventId, kind: 'thinking', text: trimmed });
      }
    } else if (ev.type === 'tool_status' && typeof ev.toolName === 'string') {
      const callId =
        typeof ev.callId === 'string' && ev.callId.trim()
          ? ev.callId.trim()
          : row.eventId;
      const status: 'running' | 'completed' | 'error' =
        ev.status === 'completed' || ev.status === 'error'
          ? ev.status
          : 'running';
      const innerToolName =
        ev.toolName === 'mcp' &&
        ev.args &&
        typeof ev.args === 'object' &&
        typeof (ev.args as { toolName?: unknown }).toolName === 'string'
          ? `mcp:${(ev.args as { toolName: string }).toolName}`
          : ev.toolName;
      const nextItem: BrainstormActivityItem = {
        id: callId,
        kind: 'tool',
        toolName: innerToolName,
        status,
        target: readToolTarget(ev.args),
        ...(typeof ev.result === 'string' && ev.result.trim()
          ? { result: ev.result.trim() }
          : {}),
      };
      const existingIdx = toolIndexByCallId.get(callId);
      if (existingIdx !== undefined) {
        items[existingIdx] = {
          ...items[existingIdx],
          ...nextItem,
          target: nextItem.target ?? items[existingIdx]?.target ?? null,
        };
      } else {
        toolIndexByCallId.set(callId, items.length);
        items.push(nextItem);
      }
    }
  }
  return items;
}

export async function loadRunActivities(
  runIds: string[],
): Promise<Map<string, BrainstormActivityItem[]>> {
  const uniqueIds = [...new Set(runIds.filter(Boolean))];
  const byRun = new Map<string, BrainstormActivityItem[]>();
  if (uniqueIds.length === 0) return byRun;

  const rows = await db
    .select({
      runId: agentRunEvents.runId,
      eventId: agentRunEvents.eventId,
      event: agentRunEvents.event,
    })
    .from(agentRunEvents)
    .where(inArray(agentRunEvents.runId, uniqueIds))
    .orderBy(asc(agentRunEvents.ordinal));

  const grouped = new Map<string, Array<{ eventId: string; event: unknown }>>();
  for (const row of rows) {
    let list = grouped.get(row.runId);
    if (!list) {
      list = [];
      grouped.set(row.runId, list);
    }
    list.push({ eventId: row.eventId, event: row.event });
  }
  for (const [runId, events] of grouped) {
    const built = buildBrainstormActivityFromEvents(events);
    if (built.length > 0) byRun.set(runId, built);
  }
  return byRun;
}

export interface OpenedTurn {
  assistant: BrainstormMessageRow;
  /** True when this turn id was already recorded; nothing new was written. */
  existing: boolean;
}

async function findOriginalAssistantRow(
  sessionId: string,
  turnId: string,
): Promise<BrainstormMessageRow | null> {
  const [row] = await db
    .select()
    .from(brainstormMessages)
    .where(
      and(
        eq(brainstormMessages.sessionId, sessionId),
        eq(brainstormMessages.turnId, turnId),
        eq(brainstormMessages.role, 'assistant'),
        isNull(brainstormMessages.retryOfMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Writes the user row and a streaming assistant row in one transaction. The
 * one-streaming index refuses a second open turn; a repeated turn id returns
 * the rows already written.
 */
export async function openTurn(input: {
  sessionId: string;
  project: string;
  turnId: string;
  text: string;
}): Promise<OpenedTurn> {
  const prior = await findOriginalAssistantRow(input.sessionId, input.turnId);
  if (prior) return { assistant: prior, existing: true };

  try {
    const nowMs = Date.now();
    const userCreatedAt = new Date(nowMs).toISOString();
    const assistantCreatedAt = new Date(nowMs + 1).toISOString();
    const assistant = await db.transaction(async (tx) => {
      await tx.insert(brainstormMessages).values({
        sessionId: input.sessionId,
        project: input.project,
        role: 'user',
        content: input.text,
        status: 'completed',
        turnId: input.turnId,
        createdAt: userCreatedAt,
        completedAt: userCreatedAt,
      });
      const [row] = await tx
        .insert(brainstormMessages)
        .values({
          sessionId: input.sessionId,
          project: input.project,
          role: 'assistant',
          content: '',
          status: 'streaming',
          turnId: input.turnId,
          createdAt: assistantCreatedAt,
        })
        .returning();
      return row!;
    });
    return { assistant, existing: false };
  } catch (err) {
    const constraint = uniqueViolation(err);
    if (constraint === ONE_STREAMING_INDEX) throw new BrainstormLedgerConflict('turn_in_progress');
    if (constraint === TURN_ROLE_INDEX) {
      const raced = await findOriginalAssistantRow(input.sessionId, input.turnId);
      if (raced) return { assistant: raced, existing: true };
    }
    throw err;
  }
}

/** Opens the replacement row for a retry and links it to the failed row. */
export async function openRetryRow(input: {
  failed: BrainstormMessageRow;
  runId: string;
}): Promise<BrainstormMessageRow> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(brainstormMessages)
        .values({
          sessionId: input.failed.sessionId,
          project: input.failed.project,
          role: 'assistant',
          content: '',
          status: 'streaming',
          turnId: input.failed.turnId,
          runId: input.runId,
          retryOfMessageId: input.failed.id,
        })
        .returning();
      await tx
        .update(brainstormMessages)
        .set({ supersededByMessageId: row!.id })
        .where(eq(brainstormMessages.id, input.failed.id));
      return row!;
    });
  } catch (err) {
    if (uniqueViolation(err) === ONE_STREAMING_INDEX) throw new BrainstormLedgerConflict('turn_in_progress');
    throw err;
  }
}

export async function attachRun(messageId: string, runId: string): Promise<void> {
  await db
    .update(brainstormMessages)
    .set({ runId })
    .where(eq(brainstormMessages.id, messageId));
}

export async function failOpenRow(messageId: string, code: BrainstormFailureCode): Promise<void> {
  await db
    .update(brainstormMessages)
    .set({
      status: 'failed',
      failureCode: code,
      failureSummary: BRAINSTORM_FAILURE_SUMMARIES[code],
      completedAt: new Date().toISOString(),
    })
    .where(and(eq(brainstormMessages.id, messageId), eq(brainstormMessages.status, 'streaming')));
}

export async function findMessage(
  sessionId: string,
  messageId: string,
): Promise<BrainstormMessageRow | null> {
  const [row] = await db
    .select()
    .from(brainstormMessages)
    .where(and(eq(brainstormMessages.sessionId, sessionId), eq(brainstormMessages.id, messageId)))
    .limit(1);
  return row ?? null;
}

export async function findAssistantByRun(
  sessionId: string,
  runId: string,
): Promise<BrainstormMessageRow | null> {
  const [row] = await db
    .select()
    .from(brainstormMessages)
    .where(
      and(
        eq(brainstormMessages.sessionId, sessionId),
        eq(brainstormMessages.runId, runId),
        eq(brainstormMessages.role, 'assistant'),
      ),
    )
    .orderBy(desc(brainstormMessages.createdAt))
    .limit(1);
  return row ?? null;
}

export async function latestAssistantRow(sessionId: string): Promise<BrainstormMessageRow | null> {
  const [row] = await db
    .select()
    .from(brainstormMessages)
    .where(and(eq(brainstormMessages.sessionId, sessionId), eq(brainstormMessages.role, 'assistant')))
    .orderBy(desc(brainstormMessages.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Orders message rows chronologically, ensuring that within the same turn or
 * identical `createdAt` timestamp (e.g. rows inserted in a single Postgres
 * transaction using `DEFAULT now()`), the `user` prompt always precedes the
 * `assistant` reply.
 */
export function orderMessagesChronologically<
  T extends Pick<BrainstormMessageRow, 'id' | 'role' | 'turnId' | 'createdAt'>,
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.turnId === b.turnId && a.role !== b.role) {
      return a.role === 'user' ? -1 : 1;
    }
    const timeDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export async function listMessages(input: {
  sessionId: string;
  project: string;
  limit: number;
  before?: string;
}): Promise<BrainstormMessageRow[]> {
  const rows = await db
    .select()
    .from(brainstormMessages)
    .where(
      and(
        eq(brainstormMessages.sessionId, input.sessionId),
        eq(brainstormMessages.project, input.project),
        input.before ? lt(brainstormMessages.createdAt, input.before) : undefined,
      ),
    )
    .orderBy(desc(brainstormMessages.createdAt))
    .limit(input.limit);
  return orderMessagesChronologically(rows);
}

export function failureCodeFor(
  status: 'failed' | 'cancelled',
  category: AiRunV2FailureCategory | null | undefined,
): BrainstormFailureCode {
  if (status === 'cancelled') return 'cancelled';
  switch (category) {
    case 'hard_timeout':
    case 'tool_timeout':
    case 'progress_timeout':
      return 'deadline_exceeded';
    case 'queue_ttl':
    case 'dispatch_ttl':
    case 'worker_start_failed':
      return 'run_not_started';
    case 'validation_failed':
      return 'worker_refused_spec';
    case 'internal_error':
      return 'model_error';
    case 'forced_cancel':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export interface InteractiveTerminalInput {
  threadId: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  failureCategory?: AiRunV2FailureCategory | null;
  /** Final or partial assistant message the worker reported, when any. */
  message?: { id: string; text: string } | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
}

/**
 * Applies a V2 interactive terminal to the Brainstorm row that owns the run.
 * Does nothing for runs that are not Brainstorm turns. Partial text from a
 * failed turn is stored on the row and hidden from the chat transcript, so it
 * never feeds a later turn.
 */
export async function finalizeBrainstormTerminal(input: InteractiveTerminalInput): Promise<void> {
  const [session] = await db
    .select({
      id: brainstormSessions.id,
      project: brainstormSessions.project,
      creatorId: brainstormSessions.creatorId,
      model: brainstormSessions.model,
    })
    .from(brainstormSessions)
    .where(eq(brainstormSessions.chatThreadId, input.threadId))
    .limit(1);
  if (!session) return;

  const nowIso = new Date().toISOString();
  const status: BrainstormMessageStatus = input.status;
  const failureCode =
    input.status === 'completed' ? null : failureCodeFor(input.status, input.failureCategory);
  let text = input.message?.text ?? '';
  if (!text.trim() && input.status === 'completed') {
    const [latest] = await db
      .select({ text: chatMessages.text })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, input.threadId),
          eq(chatMessages.role, 'agent'),
          eq(chatMessages.hidden, false),
        ),
      )
      .orderBy(desc(chatMessages.ts))
      .limit(1);
    text = latest?.text ?? '';
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(brainstormMessages)
      .set({
        status,
        content: text,
        failureCode,
        failureSummary: failureCode ? BRAINSTORM_FAILURE_SUMMARIES[failureCode] : null,
        completedAt: nowIso,
      })
      .where(
        and(
          eq(brainstormMessages.sessionId, session.id),
          eq(brainstormMessages.runId, input.runId),
          eq(brainstormMessages.status, 'streaming'),
        ),
      )
      .returning({ id: brainstormMessages.id });
    if (!row) return false;
    await tx
      .update(brainstormSessions)
      .set({
        lastActivityAt: nowIso,
        updatedAt: nowIso,
        version: sql`${brainstormSessions.version} + 1`,
      })
      .where(eq(brainstormSessions.id, session.id));
    if (failureCode && input.message?.id) {
      await tx
        .update(chatMessages)
        .set({ hidden: true })
        .where(and(eq(chatMessages.id, input.message.id), eq(chatMessages.threadId, input.threadId)));
    }
    return true;
  });
  if (!updated) return;
  if (failureCode && input.message?.id) {
    const { hideLiveThreadMessage } = await import('./chatAgentService');
    hideLiveThreadMessage(input.threadId, input.message.id);
  }

  trackEvent(failureCode ? 'brainstorm.turn.failed' : 'brainstorm.turn.completed', {
    project: session.project,
    sessionId: session.id,
    runId: input.runId,
    ...(failureCode ? { failureCode } : {}),
  });

  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;
  const costUsd = await computeCost({
    provider: 'cursor',
    modelId: session.model,
    inputTokens,
    outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
  }).catch(() => 0);
  recordAiUsage({
    ...brainstormUsageCtx(session.project, session.id, session.creatorId),
    provider: 'cursor',
    modelId: session.model,
    threadId: input.threadId,
    runId: input.runId,
    inputTokens,
    outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    tokenSource: 'exact',
    costUsd,
    costSource: 'computed',
    durationMs: input.durationMs,
    status: input.status === 'completed' ? 'success' : input.status === 'cancelled' ? 'cancelled' : 'error',
  });
}

/**
 * Closes streaming rows whose run already ended, for terminals the ingest
 * hook missed. Usage is not recorded here: the counts are only on the terminal.
 */
export async function reconcileStreamingRows(sessionId: string, threadId: string): Promise<void> {
  const open = await db
    .select({ id: brainstormMessages.id, runId: brainstormMessages.runId, createdAt: brainstormMessages.createdAt })
    .from(brainstormMessages)
    .where(
      and(
        eq(brainstormMessages.sessionId, sessionId),
        eq(brainstormMessages.status, 'streaming'),
        isNotNull(brainstormMessages.runId),
      ),
    );
  if (open.length === 0) return;

  const runs = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(inArray(agentRuns.id, open.map((row) => row.runId!)));
  const terminal = new Map(
    runs
      .filter((run) => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
      .map((run) => [run.id, run.status as 'completed' | 'failed' | 'cancelled']),
  );

  for (const row of open) {
    const status = terminal.get(row.runId!);
    if (!status) continue;
    let message: { id: string; text: string } | null = null;
    if (status === 'completed') {
      const [reply] = await db
        .select({ id: chatMessages.id, text: chatMessages.text })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.threadId, threadId),
            eq(chatMessages.role, 'agent'),
            sql`${chatMessages.ts} >= ${row.createdAt}`,
          ),
        )
        .orderBy(asc(chatMessages.ts))
        .limit(1);
      message = reply ?? null;
    }
    await finalizeBrainstormTerminal({ threadId, runId: row.runId!, status, message });
  }
}
