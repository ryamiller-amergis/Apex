/**
 * Stops non-terminal Cloud Agent runs belonging to a build run (FEAT-016, PBI-035, TBI-029 / S4).
 */
import { eq, inArray } from 'drizzle-orm';
import { isAgentRunTerminalStatus } from '../../shared/types/agentRunLifecycle';
import { db } from '../db/drizzle';
import { agentRuns, buildRevisions, buildTasks } from '../db/schema';
import { markTerminal, requestCancel } from './agentRunLifecycleService';
import { appendBuildEvent } from './buildEventsService';
import { cancelCursorCloudAgentRun } from './cursorCloudAgentClient';

export interface StopRunningAgentsDeps {
  listNonTerminalAgentRuns: (buildRunId: string) => Promise<
    Array<{
      id: string;
      status: string;
      projectId: string | null;
      cloudAgentIdentity: string | null;
      dispatchMessageId: string | null;
    }>
  >;
  cancelSingleAgent: (agentRun: {
    id: string;
    projectId: string | null;
    cloudAgentIdentity: string | null;
    dispatchMessageId: string | null;
  }) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
}

const defaultDeps: StopRunningAgentsDeps = {
  async listNonTerminalAgentRuns(buildRunId) {
    const revRows = await db
      .select({ id: buildRevisions.id })
      .from(buildRevisions)
      .where(eq(buildRevisions.buildRunId, buildRunId));
    if (revRows.length === 0) return [];

    const taskRows = await db
      .select({ id: buildTasks.id })
      .from(buildTasks)
      .where(
        inArray(
          buildTasks.buildRevisionId,
          revRows.map((r) => r.id),
        ),
      );
    if (taskRows.length === 0) return [];

    const runs = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        projectId: agentRuns.projectId,
        cloudAgentIdentity: agentRuns.cloudAgentIdentity,
        dispatchMessageId: agentRuns.dispatchMessageId,
      })
      .from(agentRuns)
      .where(
        inArray(
          agentRuns.buildTaskId,
          taskRows.map((t) => t.id),
        ),
      );
    return runs.filter((r) => !isAgentRunTerminalStatus(r.status));
  },
  async cancelSingleAgent(agent) {
    await requestCancel(agent.id);
    if (agent.projectId && agent.cloudAgentIdentity && agent.dispatchMessageId) {
      await cancelCursorCloudAgentRun({
        project: agent.projectId,
        cloudAgentId: agent.cloudAgentIdentity,
        cursorRunId: agent.dispatchMessageId,
      });
    }
    await markTerminal(agent.id, {
      status: 'cancelled',
      terminalReason: 'forced_cancel',
      ...(agent.dispatchMessageId
        ? { dispatchMessageId: agent.dispatchMessageId }
        : {}),
    });
  },
  async appendEvent(input) {
    await appendBuildEvent(input);
  },
};

export async function stopRunningAgents(
  buildRunId: string,
  deps: StopRunningAgentsDeps = defaultDeps,
): Promise<{ stopped: number; unconfirmed: string[] }> {
  let stopped = 0;
  const unconfirmed: string[] = [];
  const seen = new Set<string>();

  // Two passes to catch any agent launched in the gap before the status change settled
  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await deps.listNonTerminalAgentRuns(buildRunId);
    for (const agent of candidates) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      try {
        await deps.cancelSingleAgent(agent);
        stopped += 1;
      } catch (err) {
        unconfirmed.push(agent.id);
        await deps.appendEvent({
          buildRunId,
          eventType: 'agent_cancel_failed',
          severity: 'warn',
          message: 'One build agent did not confirm cancellation.',
          detail: {
            agentRunId: agent.id,
            errorClass: err instanceof Error ? err.name : 'Error',
          },
        });
      }
    }
  }

  return { stopped, unconfirmed };
}
