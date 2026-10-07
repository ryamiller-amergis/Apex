/**
 * The `interview` step type.
 *
 * The step starts one interview and parks. Turns stay in the interview service; this adapter does
 * not speak to the BA. A missing or disabled profile fails before a thread or interview exists, and
 * the profile copied onto the thread is the one the run keeps even if Project Settings change later.
 *
 * The run initiator is the interview author. Facilitator reassignment is not part of this step.
 */
import type { ChatThreadKickoff } from '../../../shared/types/chat';
import type {
  InterviewProfileSnapshot,
  InterviewStepConfig,
  InterviewStepMode,
} from '../../../shared/types/playbook';
import type { InterviewSkillOption, ProjectSkillConfig } from '../../../shared/types/projectSettings';
import { createThread, sendMessage } from '../chatAgentService';
import { isFeatureEnabled } from '../featureFlagService';
import { createInterview } from '../interviewService';
import { resolveSkillConfig } from '../projectSettingsService';
import { parseStepInput } from './descriptorValidation';
import { resolveDeadlineMs } from './registry';
import {
  deadlineFromNow,
  suspendStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'interview';
const DEFAULT_INTERVIEW_SKILL_PATH = '.cursor/skills/grill-with-docs/SKILL.md';
const INTERVIEW_ORCHESTRATOR_SKILL_PATH = '.cursor/skills/interview-orchestrator/SKILL.md';

export class PlaybookInterviewProfileError extends Error {
  constructor(project: string, profileKey: string) {
    super(`Interview profile "${profileKey}" is missing or disabled for project ${project}.`);
    this.name = 'PlaybookInterviewProfileError';
  }
}

export class PlaybookInterviewDisabledError extends Error {
  constructor(project: string) {
    super(`The Playbook interview step is disabled for project ${project}.`);
    this.name = 'PlaybookInterviewDisabledError';
  }
}

interface InterviewThreadKickoff extends ChatThreadKickoff {
  playbookInterview: {
    runId: string;
    stepId: string;
    snapshot: InterviewProfileSnapshot;
  };
}

function enabledProfile(
  options: InterviewSkillOption[] | null | undefined,
  profileKey: string
): InterviewSkillOption | undefined {
  const key = profileKey.trim();
  return (options ?? []).find(
    (option) => Boolean(option.key?.trim()) && option.key?.trim() === key && option.enabled !== false
  );
}

function snapshotProfile(
  mode: InterviewStepMode,
  option: InterviewSkillOption,
  skillConfig: ProjectSkillConfig
): InterviewProfileSnapshot {
  const skillPath =
    option.path.trim() ||
    skillConfig.interviewSkillPath?.trim() ||
    DEFAULT_INTERVIEW_SKILL_PATH;

  return {
    mode,
    key: option.key!.trim(),
    skillPath,
    model: option.model ?? skillConfig.interviewModel ?? skillConfig.defaultModel ?? null,
    effort: option.effort ?? skillConfig.interviewEffort ?? null,
    wantsDesignPrototype: option.wantsDesignPrototype !== false,
    wantsTestCases: option.wantsTestCases !== false,
  };
}

export async function executeInterviewStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<InterviewStepConfig>(STEP_TYPE, context.config);
  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs);

  const enabled = await isFeatureEnabled('playbook-interview-step', {
    userId: context.initiatorUserId,
    project: context.project,
  });

  // @feature-flag:playbook-interview-step start winner=enabled
  if (!enabled) {
    // @feature-flag:playbook-interview-step disabled-start
    throw new PlaybookInterviewDisabledError(context.project);
    // @feature-flag:playbook-interview-step disabled-end
  }
  // @feature-flag:playbook-interview-step enabled-start
  // Enabled projects may resolve the configured profile and create the interview.
  // @feature-flag:playbook-interview-step enabled-end
  // @feature-flag:playbook-interview-step end

  // Read the project's skill settings before inserting anything. A bad key must leave no thread.
  const skillConfig = await resolveSkillConfig({ project: context.project });
  const option = enabledProfile(skillConfig?.interviewSkillOptions, config.profileKey);
  if (!skillConfig || !option?.key?.trim()) {
    throw new PlaybookInterviewProfileError(context.project, config.profileKey.trim());
  }

  const snapshot = snapshotProfile(config.mode, option, skillConfig);
  const kickoff: InterviewThreadKickoff = {
    project: context.project,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch,
    skillProvider: skillConfig.skillProvider,
    skillPath:
      snapshot.mode === 'multi_agent_assisted'
        ? INTERVIEW_ORCHESTRATOR_SKILL_PATH
        : snapshot.skillPath,
    model: snapshot.model ?? undefined,
    effort: snapshot.effort ?? undefined,
    skillSettingsId: skillConfig.id,
    playbookInterview: {
      runId: context.runId,
      stepId: context.stepId,
      snapshot,
    },
  };

  const thread = await createThread(context.initiatorUserId, kickoff, { skipAutoKickoff: true });
  const interview = await createInterview({
    userId: context.initiatorUserId,
    project: context.project,
    repo: skillConfig.skillRepo,
    title: option.friendlyName,
    chatThreadId: thread.id,
    model: snapshot.model ?? undefined,
    effort: snapshot.effort ?? undefined,
    skillSettingsId: skillConfig.id,
    prototypeStageEnabled: snapshot.wantsDesignPrototype,
    testCasesEnabled: snapshot.wantsTestCases,
    playbookRunId: context.runId,
    playbookStepRunId: context.stepRunId,
    playbookInterviewMode: snapshot.mode,
    playbookProfileKey: snapshot.key,
    playbookProfileSnapshot: snapshot,
  });

  const expiresAt = deadlineFromNow(deadlineMs);
  await suspendStepRun({
    stepRunId: context.stepRunId,
    expiresAt,
    resumeToken: interview.interviewId,
  });
  void sendMessage(thread.id, 'Begin.').catch((error: unknown) => {
    console.error(
      `[playbook-interview] Failed to start interview ${interview.interviewId}:`,
      error,
    );
  });

  return { kind: 'suspended', expiresAt };
}
