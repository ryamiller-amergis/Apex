/**
 * The live log for one Playbook step: the agent run's phase plus the agent's thread messages
 * (tool calls, reasoning, replies). Thread messages are written as the agent works, so polling
 * this shows progress while the step is still running.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns } from '../db/schema';
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
  activity.entries = threadActivityEntries(thread?.messages ?? []);
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
