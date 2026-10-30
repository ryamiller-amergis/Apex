/**
 * The live log for one Playbook step: the agent run's phase plus the agent's thread messages
 * (tool calls, reasoning, replies). Thread messages are written as the agent works, so polling
 * this shows progress while the step is still running.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRunEvents, agentRuns } from '../db/schema';
import type { ChatMessage } from '../../shared/types/chat';
import type {
  PlaybookStepActivity,
  PlaybookStepActivityEntry,
} from '../../shared/types/playbook';
import { getThread } from './chatAgentService';
import { getRun } from './playbookRunProjectionService';

const MAX_ENTRIES = 300;
const MAX_DETAIL_CHARS = 1200;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…` : trimmed;
}

/** The argument a reader cares about for a tool call: a path, a command, or a query. */
function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['path', 'target_file', 'file', 'command', 'query', 'pattern', 'url', 'glob_pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return clip(value);
  }
  const json = JSON.stringify(input);
  return json === '{}' ? undefined : clip(json);
}

/** Progress the document worker stored while the agent ran. The chat thread is empty for that lane. */
export function runEventActivityEntries(
  rows: ReadonlyArray<{ eventId: string; detail: string | null; event: unknown; at: string }>,
): PlaybookStepActivityEntry[] {
  const entries: PlaybookStepActivityEntry[] = [];
  for (const row of rows) {
    const event = row.event && typeof row.event === 'object'
      ? row.event as Record<string, unknown>
      : {};
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'tool_call' || type === 'tool_status') {
      const input = event.input && typeof event.input === 'object'
        ? event.input as Record<string, unknown>
        : event.args && typeof event.args === 'object'
          ? event.args as Record<string, unknown>
          : undefined;
      const keysOnly = input && Object.keys(input).every((key) => key === 'keys');
      entries.push({
        id: row.eventId,
        kind: 'tool',
        title: typeof event.toolName === 'string' && event.toolName ? event.toolName : 'Tool',
        detail: (keysOnly ? undefined : toolDetail(input)) ?? (row.detail ? clip(row.detail) : undefined),
        at: row.at,
      });
      continue;
    }
    if (type === 'thinking') {
      const text = typeof event.text === 'string' ? event.text : row.detail;
      if (!text?.trim()) continue;
      entries.push({ id: row.eventId, kind: 'thinking', title: 'Thinking', detail: clip(text), at: row.at });
      continue;
    }
    if (type === 'error') {
      const text = typeof event.error === 'string' ? event.error : row.detail;
      if (!text?.trim()) continue;
      entries.push({ id: row.eventId, kind: 'error', title: 'Error', detail: clip(text), at: row.at });
      continue;
    }
    if (row.detail?.trim()) {
      const title = clip(row.detail);
      if (entries.at(-1)?.title === title) continue;
      entries.push({ id: row.eventId, kind: 'status', title, at: row.at });
    }
  }
  return entries.slice(-MAX_ENTRIES);
}

export function threadActivityEntries(messages: readonly ChatMessage[]): PlaybookStepActivityEntry[] {
  const entries: PlaybookStepActivityEntry[] = [];
  for (const message of messages) {
    if (message.hidden) continue;
    if (message.role === 'tool') {
      entries.push({
        id: message.id,
        kind: 'tool',
        title: message.toolName ?? message.text.replace(/^→\s*/, ''),
        detail: toolDetail(message.toolInput),
        at: message.ts,
      });
    } else if (message.role === 'agent' && message.toolName === '_reasoning') {
      entries.push({ id: message.id, kind: 'thinking', title: 'Thinking', detail: clip(message.text), at: message.ts });
    } else if (message.role === 'agent') {
      if (!message.text.trim()) continue;
      entries.push({ id: message.id, kind: 'message', title: 'Agent', detail: clip(message.text), at: message.ts });
    } else if (message.role === 'user') {
      entries.push({ id: message.id, kind: 'prompt', title: 'Prompt', detail: clip(message.text), at: message.ts });
    } else if (message.role === 'system' && message.text.trim()) {
      entries.push({ id: message.id, kind: 'status', title: clip(message.text), at: message.ts });
    }
  }
  return entries.slice(-MAX_ENTRIES);
}

export async function getPlaybookStepActivity(input: {
  project: string;
  runId: string;
  stepRunId: string;
}): Promise<PlaybookStepActivity | null> {
  const run = await getRun(input.project, input.runId);
  const step = run?.steps.find((candidate) => candidate.id === input.stepRunId);
  if (!run || !step) return null;

  const activity: PlaybookStepActivity = {
    stepRunId: step.id,
    status: step.status,
    agentRun: null,
    entries: [],
  };
  if (step.stepType !== 'cursor-agent' || !step.agentRunId) return activity;

  const [agentRun] = await db.select({
    status: agentRuns.status,
    threadId: agentRuns.threadId,
    progressPhase: agentRuns.progressPhase,
    progressLabel: agentRuns.progressLabel,
    queuedAt: agentRuns.queuedAt,
    startedAt: agentRuns.startedAt,
    progressAt: agentRuns.progressAt,
    lastError: agentRuns.lastError,
  }).from(agentRuns).where(eq(agentRuns.id, step.agentRunId)).limit(1);
  if (!agentRun) return activity;

  activity.agentRun = {
    status: agentRun.status,
    phase: agentRun.progressPhase ?? null,
    label: agentRun.progressLabel ?? null,
    queuedAt: agentRun.queuedAt ?? null,
    startedAt: agentRun.startedAt ?? null,
    progressAt: agentRun.progressAt ?? null,
    lastError: agentRun.lastError ?? null,
  };
  const thread = await getThread(agentRun.threadId);
  const fromThread = threadActivityEntries(thread?.messages ?? []);
  if (fromThread.length > 0) {
    activity.entries = fromThread;
  } else {
    const events = await db
      .select({
        eventId: agentRunEvents.eventId,
        detail: agentRunEvents.detail,
        event: agentRunEvents.event,
        at: agentRunEvents.eventTimestamp,
      })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, step.agentRunId))
      .orderBy(asc(agentRunEvents.sequence))
      .limit(MAX_ENTRIES);
    activity.entries = runEventActivityEntries(events);
  }
  if (agentRun.lastError) {
    activity.entries.push({
      id: `${step.agentRunId}-error`,
      kind: 'error',
      title: 'Agent run error',
      detail: clip(agentRun.lastError),
      at: agentRun.progressAt ?? step.updatedAt,
    });
  }
  return activity;
}
