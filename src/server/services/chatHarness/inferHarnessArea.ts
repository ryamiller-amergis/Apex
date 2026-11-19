/**
 * Single source of truth for inferring a chat thread's harness area from its
 * stamped column or legacy kickoff metadata, and upgrading pre-release
 * unstamped threads in place on their first harness turn (TBI-014 / PBI-007 / BR-012).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chatThreads } from '../../db/schema';
import type { ChatThread, ChatThreadKickoff } from '../../../shared/types/chat';
import {
  isHarnessAreaId,
  type HarnessAreaId,
} from '../../../shared/types/chatHarness';
import { isCabReleaseSkillPath } from '../../../shared/utils/cabReleaseSkill';
import { isBuildIntakeThread } from '../buildIntakeThread';

function isBuildIntakeSkillPath(skillPath: string | null | undefined): boolean {
  if (!skillPath) return false;
  const normalized = skillPath.replace(/\\/g, '/').trim().toLowerCase();
  return (
    normalized === 'build-intake/skill.md' ||
    normalized.endsWith('/build-intake/skill.md') ||
    normalized.includes('/build-intake/')
  );
}

function hasPlaybookInterviewKickoff(kickoff: ChatThreadKickoff): boolean {
  const candidate = kickoff as ChatThreadKickoff & {
    playbookInterview?: unknown;
  };
  return (
    candidate.playbookInterview !== undefined &&
    candidate.playbookInterview !== null
  );
}

/**
 * Infer the harness area for a thread, preferring the stamped `harnessArea`
 * and falling back to legacy kickoff metadata (`agentModule`, `assistantType`,
 * `mode`, `skillPath`, etc.) for pre-release threads.
 */
export function inferHarnessArea(
  thread: Pick<ChatThread, 'harnessArea' | 'kickoff'>,
): HarnessAreaId {
  if (isHarnessAreaId(thread.harnessArea)) {
    return thread.harnessArea;
  }

  const { kickoff } = thread;
  if (kickoff.agentModule === 'brainstorm') return 'brainstorm';
  if (kickoff.askApex === true) return 'ask-apex';
  if (
    kickoff.assistantType === 'calendar-work-item' ||
    kickoff.agentModule === 'calendarAssistant' ||
    Boolean(kickoff.calendarAssistantSessionId) ||
    kickoff.calendarAnchorWorkItemId !== undefined
  ) {
    return 'calendar-work-item';
  }
  if (
    kickoff.assistantType === 'prd' ||
    kickoff.agentModule === 'prdAssistant'
  ) {
    return 'prd-assistant';
  }
  if (
    kickoff.assistantType === 'design-doc' ||
    kickoff.agentModule === 'designDocAssistant'
  ) {
    return 'design-doc-assistant';
  }
  if (kickoff.assistantType === 'adr' || kickoff.agentModule === 'adr') {
    return 'adr';
  }
  if (Boolean(kickoff.qaLabSuiteId) || kickoff.agentModule === 'testCase') {
    return 'qa-lab';
  }
  if (
    kickoff.mode === 'standup-participant' ||
    kickoff.mode === 'standup-followup' ||
    Boolean(kickoff.standupSessionId) ||
    Boolean(kickoff.standupParticipantId) ||
    kickoff.agentModule === 'standup'
  ) {
    return 'standup-participant';
  }
  if (isCabReleaseSkillPath(kickoff.skillPath)) {
    return 'cab-release';
  }
  if (
    isBuildIntakeThread(thread as ChatThread) ||
    isBuildIntakeSkillPath(kickoff.skillPath)
  ) {
    return 'build-intake';
  }
  if (
    kickoff.agentModule === 'interview' ||
    hasPlaybookInterviewKickoff(kickoff)
  ) {
    return 'interview';
  }
  return 'agent-home';
}

/**
 * Convenience wrapper to infer a harness area directly from kickoff metadata
 * before a thread row has been stamped.
 */
export function inferHarnessAreaFromKickoff(
  kickoff: ChatThreadKickoff,
): HarnessAreaId {
  return inferHarnessArea({ harnessArea: null, kickoff });
}

/**
 * Stamp `harness_area` and `harness_version` onto a pre-release unstamped
 * `chat_threads` row in place. Additive and idempotent (`WHERE harness_area IS NULL`);
 * never modifies `chat_messages` or `cursor_agent_id`.
 *
 * Returns true if the row was stamped, false if it was already stamped or missing.
 */
export async function stampThreadHarnessIfMissing(
  threadId: string,
  area: HarnessAreaId,
  version: number,
): Promise<boolean> {
  const updated = await db
    .update(chatThreads)
    .set({
      harnessArea: area,
      harnessVersion: version,
    })
    .where(and(eq(chatThreads.id, threadId), isNull(chatThreads.harnessArea)))
    .returning({ id: chatThreads.id });
  return updated.length > 0;
}
