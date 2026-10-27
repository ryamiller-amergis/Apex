/**
 * The `interview` step type.
 *
 * The step starts one interview and parks. Turns stay in the interview service; this adapter does
 * not speak to the BA. A missing or disabled profile fails before a thread or interview exists, and
 * the profile copied onto the thread is the one the run keeps even if Project Settings change later.
 *
 * The run initiator is the interview author. Facilitator reassignment is not part of this step.
 */
import { BUILD_INTAKE_OPTION_KEY } from '../../../shared/types/buildPreflight';
import type { ChatThreadKickoff } from '../../../shared/types/chat';
import type {
  InterviewProfileSnapshot,
  InterviewStepConfig,
  InterviewStepMode,
} from '../../../shared/types/playbook';
import type { InterviewSkillOption, ProjectSkillConfig } from '../../../shared/types/projectSettings';
import { BUILD_INTAKE_SEED_TURN_ID, prepareBuildIntakeTurn } from '../buildIntakeService';
import { findBuildByPlaybookRun, linkBuildInterview, type BuildForPlaybookRun } from '../buildOrchestrator/store';
import { createThread, sendMessage } from '../chatAgentService';
import { isFeatureEnabled } from '../featureFlagService';
import { createInterview } from '../interviewService';
import { resolveSkillConfig } from '../projectSettingsService';
import { trackEvent } from '../telemetry';
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

/** The opening message is the requester's prompt on a build intake, so it goes through the same turn hook. */
async function startInterview(threadId: string, opening: string, isBuildIntake: boolean): Promise<void> {
  if (!isBuildIntake) {
    await sendMessage(threadId, opening);
    return;
  }
  const prepared = await prepareBuildIntakeTurn({
    threadId,
    messageText: opening,
    turnId: BUILD_INTAKE_SEED_TURN_ID,
  });
  await sendMessage(threadId, opening, undefined, [], { internalContext: prepared.internalContext });
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
  const skillConfig = await resolveSkillConfig({
    project: context.project,
    ...(config.skillSettingsId ? { settingsId: config.skillSettingsId } : {}),
  });
  const isBuildIntake = config.profileKey.trim() === BUILD_INTAKE_OPTION_KEY;
  const option = enabledProfile(skillConfig?.interviewSkillOptions, config.profileKey);
  if (!skillConfig || !option?.key?.trim()) {
    if (isBuildIntake) trackEvent('build.intake.profile_refused', { reason: 'missing_intake_role' });
    throw new PlaybookInterviewProfileError(context.project, config.profileKey.trim());
  }

  // A build intake is grounded on the build's target repository; the skill still loads from skillRepo.
  let build: BuildForPlaybookRun | null = null;
  if (isBuildIntake) {
    build = await findBuildByPlaybookRun(context.runId);
    if (!build) {
      trackEvent('build.intake.profile_refused', { reason: 'missing_build_run' });
      throw new PlaybookInterviewProfileError(context.project, config.profileKey.trim());
    }
  }

  const profile = snapshotProfile(config.mode, option, skillConfig);
  const snapshot: InterviewProfileSnapshot = isBuildIntake
    ? { ...profile, wantsDesignPrototype: false, wantsTestCases: false }
    : profile;
  const groundingRepo = build?.repository ?? skillConfig.skillRepo;
  const kickoff: InterviewThreadKickoff = {
    project: context.project,
    repo: groundingRepo,
    ...(build ? { skillRepo: skillConfig.skillRepo } : {}),
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
    repo: groundingRepo,
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
  if (build) await linkBuildInterview(build.id, interview.interviewId);
  const opening = config.openingMessage?.trim() || 'Begin.';
  void startInterview(thread.id, opening, isBuildIntake).catch((error: unknown) => {
    console.error(
      `[playbook-interview] Failed to start interview ${interview.interviewId}:`,
      error,
    );
  });

  return { kind: 'suspended', expiresAt };
}
