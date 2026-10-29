/**
 * Reads build-intake facts off a chat thread. Keep this free of service imports:
 * `threadAccessService` uses it inside the durable admit call graph.
 */
import type { ChatThread } from '../../shared/types/chat';
import { BUILD_INTAKE_OPTION_KEY } from '../../shared/types/buildPreflight';

interface BuildIntakeKickoff {
  playbookInterview?: { runId?: string; snapshot?: { key?: string } };
}

function intakeKickoff(thread: ChatThread): BuildIntakeKickoff {
  return thread.kickoff as ChatThread['kickoff'] & BuildIntakeKickoff;
}

export function isBuildIntakeThread(thread: ChatThread): boolean {
  return intakeKickoff(thread).playbookInterview?.snapshot?.key === BUILD_INTAKE_OPTION_KEY;
}

export function buildIntakeRunId(thread: ChatThread): string | undefined {
  return intakeKickoff(thread).playbookInterview?.runId;
}
