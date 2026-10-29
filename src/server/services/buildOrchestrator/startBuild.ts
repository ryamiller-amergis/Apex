import {
  BUILD_CLIENT_REQUEST_ID_MAX_LENGTH,
  BUILD_PROMPT_MAX_LENGTH,
} from '../../../shared/types/build';
import type { StartBuildResponse } from '../../../shared/types/build';
import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';
import { preflightRefusalSummary } from '../../../shared/types/buildPreflight';
import type { FrozenBuildRunConfig, PreflightResult } from '../../../shared/types/buildPreflight';
import { isBuildFromPromptEnabled, isBuildPairAllowed } from '../buildAccessService';
import { runPreflight } from '../buildPreflight';
import { fetchAvailableModels } from '../modelsService';
import { listSkillConfigsForProject } from '../projectSettingsService';
import { PlaybookGuardViolationError } from '../playbookGuardService';
import { PlaybookSpendCapExceededError } from '../playbookSpendPolicyService';
import { startRun } from '../playbookRunService';
import { trackEvent } from '../telemetry';
import { decideAdmission } from './admission';
import { BuildStartError } from './errors';
import { ensurePublished } from './provisioner';
import { capsFromFrozen, contactsFromFrozen, snapshotFromFrozen } from './snapshot';
import {
  countOlderQueued,
  countSlots,
  currentQueueReason,
  findBuildByClientRequest,
  insertBuild,
  isUniqueViolation,
  linkPlaybookRun,
  markBuildFailed,
  queuePositionFor,
  withAdmissionLock,
  writeBuildEvent,
  type StoredBuild,
} from './store';

export interface StartBuildCommand {
  requesterUserId: string;
  project: string;
  repository: string;
  prompt: string;
  model?: string;
  clientRequestId: string;
}

export interface StartBuildDeps {
  isEnabled: (ctx: { userId: string; project: string }) => Promise<boolean>;
  isAllowed: (project: string, repository: string) => Promise<boolean>;
  listConfigs: (project: string) => Promise<ProjectSkillConfig[]>;
  listModels: () => Promise<Array<{ id: string }>>;
  preflight: (input: { project: string; repository: string; userId: string }) => Promise<PreflightResult>;
  ensurePublished: (project: string, userId: string) => Promise<{ definitionId: string }>;
  startRun: (input: {
    project: string;
    definitionId: string;
    initiatorUserId: string;
    runInput: Record<string, unknown>;
  }) => Promise<{ runId: string }>;
  findReplay: typeof findBuildByClientRequest;
  admit: typeof admitBuild;
  linkPlaybookRun: typeof linkPlaybookRun;
  markFailed: typeof markBuildFailed;
  queuePosition: typeof queuePositionFor;
  queueReason: typeof currentQueueReason;
  writeEvent: typeof writeBuildEvent;
  now: () => Date;
  track: typeof trackEvent;
}

const defaultDeps: StartBuildDeps = {
  isEnabled: isBuildFromPromptEnabled,
  isAllowed: isBuildPairAllowed,
  listConfigs: listSkillConfigsForProject,
  listModels: fetchAvailableModels,
  preflight: runPreflight,
  ensurePublished,
  startRun,
  findReplay: findBuildByClientRequest,
  admit: admitBuild,
  linkPlaybookRun,
  markFailed: markBuildFailed,
  queuePosition: queuePositionFor,
  queueReason: currentQueueReason,
  writeEvent: writeBuildEvent,
  now: () => new Date(),
  track: trackEvent,
};

export async function startBuild(
  command: StartBuildCommand,
  deps: StartBuildDeps = defaultDeps,
): Promise<StartBuildResponse> {
  const prompt = command.prompt.trim();
  const clientRequestId = command.clientRequestId.trim();
  const repository = command.repository.trim();
  if (!repository || prompt.length < 1 || prompt.length > BUILD_PROMPT_MAX_LENGTH) {
    throw new BuildStartError(400, 'BAD_REQUEST', 'Enter a repository and a description of 1 to 8000 characters.');
  }
  if (clientRequestId.length < 1 || clientRequestId.length > BUILD_CLIENT_REQUEST_ID_MAX_LENGTH) {
    throw new BuildStartError(400, 'BAD_REQUEST', 'The client request id is missing or too long.');
  }

  const replay = await deps.findReplay(command.project, command.requesterUserId, clientRequestId);
  if (replay) return toResponse(replay, true, deps, undefined);

  const enabled = await deps.isEnabled({ userId: command.requesterUserId, project: command.project });
  // @feature-flag:build-from-prompt start winner=enabled
  if (!enabled) {
    // @feature-flag:build-from-prompt disabled-start
    deps.track('build.start.refused', { code: 'BUILDS_DISABLED' });
    throw new BuildStartError(409, 'BUILDS_DISABLED', 'Builds are turned off for this project.');
    // @feature-flag:build-from-prompt disabled-end
  }
  // @feature-flag:build-from-prompt enabled-start
  if (!(await deps.isAllowed(command.project, repository))) {
    deps.track('build.start.refused', { code: 'BUILD_REPOSITORY_NOT_ALLOWED' });
    throw new BuildStartError(409, 'BUILD_REPOSITORY_NOT_ALLOWED', 'That repository is not approved for builds.');
  }

  const settings = pickSkillSettings(await deps.listConfigs(command.project), repository);
  if (!settings) {
    throw new BuildStartError(400, 'BAD_REQUEST', 'That repository is not configured for this project.');
  }

  const model = command.model?.trim() || undefined;
  if (model) {
    const models = await deps.listModels();
    if (!models.some((item) => item.id === model)) {
      throw new BuildStartError(400, 'BAD_REQUEST', 'That model is not available.');
    }
  }

  const preflight = await deps.preflight({
    project: command.project,
    repository,
    userId: command.requesterUserId,
  });
  if (!preflight.ok) {
    deps.track('build.start.refused', { code: 'BUILD_PREFLIGHT_REFUSED' });
    throw new BuildStartError(
      409,
      'BUILD_PREFLIGHT_REFUSED',
      preflightRefusalSummary(preflight.refusals.length),
      preflight.refusals,
    );
  }

  const admitted = await deps.admit({
    command: { ...command, repository, prompt, clientRequestId, model },
    settingsId: settings.id,
    config: preflight.config,
    now: deps.now(),
  });
  if (admitted.replayed) {
    deps.track('build.start.replayed', {});
    return toResponse(admitted.build, true, deps, admitted.queueReason);
  }

  await deps.writeEvent(eventInput(admitted.build, 'build.requested', 'Build requested', model ?? null));
  if (admitted.build.status === 'queued') {
    await deps.writeEvent(eventInput(admitted.build, 'build.queued', 'Build queued', model ?? null));
    deps.track('build.start.accepted', { status: 'queued' });
    return toResponse(admitted.build, false, deps, admitted.queueReason);
  }

  try {
    const published = await deps.ensurePublished(command.project, command.requesterUserId);
    const run = await deps.startRun({
      project: command.project,
      definitionId: published.definitionId,
      initiatorUserId: command.requesterUserId,
      runInput: {
        buildRunId: admitted.build.id,
        prompt,
        skillSettingsId: settings.id,
      },
    });
    await deps.linkPlaybookRun(admitted.build.id, run.runId);
    admitted.build.playbookRunId = run.runId;
    await deps.writeEvent(eventInput(admitted.build, 'build.started', 'Build started', model ?? null));
    deps.track('build.start.accepted', { status: 'intake' });
    return toResponse(admitted.build, false, deps, null);
  } catch (error) {
    await deps.markFailed(admitted.build.id);
    await deps.writeEvent(eventInput(admitted.build, 'build.start_failed', 'Build failed to start', model ?? null));
    deps.track('build.start.failed', { errorClass: error instanceof Error ? error.name : 'Error' });
    throw mapStartFailure(error);
  }
  // @feature-flag:build-from-prompt enabled-end
  // @feature-flag:build-from-prompt end
}

function eventInput(build: StoredBuild, eventType: string, message: string, model: string | null) {
  return {
    buildRunId: build.id,
    eventType,
    message,
    repository: build.repository,
    model,
    promptLength: build.prompt.length,
    actorUserId: build.requestedByUserId,
    dedupeKey: `${eventType}:${build.id}`,
  };
}

function mapStartFailure(error: unknown): BuildStartError {
  if (error instanceof PlaybookGuardViolationError) {
    return new BuildStartError(409, 'BUILD_PLAYBOOK_LIMIT', 'This project already has as many waiting builds as it can hold.');
  }
  if (error instanceof PlaybookSpendCapExceededError) {
    return new BuildStartError(409, 'PLAYBOOK_SPEND_CAP_EXCEEDED', 'This project has reached its Playbook spend cap.');
  }
  if (error instanceof BuildStartError) return error;
  return new BuildStartError(500, 'BUILD_START_FAILED', 'The build could not be started.');
}

function pickSkillSettings(configs: ProjectSkillConfig[], repository: string): ProjectSkillConfig | null {
  const matches = configs
    .filter((config) => config.skillRepo.toLowerCase() === repository.toLowerCase())
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.friendlyName.localeCompare(b.friendlyName));
  return matches[0] ?? null;
}

async function toResponse(
  build: StoredBuild,
  replayed: boolean,
  deps: StartBuildDeps,
  knownQueueReason: AdmissionQueueReason | undefined,
): Promise<StartBuildResponse> {
  const queued = build.status === 'queued';
  const queueReason = !queued
    ? null
    : knownQueueReason === undefined
      ? await deps.queueReason(build.project)
      : knownQueueReason;
  return {
    buildRunId: build.id,
    playbookRunId: build.playbookRunId,
    status: build.status === 'failed' ? 'failed' : queued ? 'queued' : 'intake',
    queuePosition: queued ? await deps.queuePosition(build.project, build.id) : null,
    queueReason,
    replayed,
  };
}

export interface AdmitInput {
  command: StartBuildCommand & { repository: string; prompt: string; clientRequestId: string; model?: string };
  settingsId: string;
  config: FrozenBuildRunConfig;
  now: Date;
}

export async function admitBuild(input: AdmitInput): Promise<{
  build: StoredBuild;
  replayed: boolean;
  queueReason: AdmissionQueueReason | undefined;
}> {
  const nowIso = input.now.toISOString();
  try {
    return await withAdmissionLock(async (tx) => {
      const counts = {
        projectSlots: await countSlots(tx, input.command.project),
        platformSlots: await countSlots(tx),
        olderQueued: await countOlderQueued(tx, input.command.project, nowIso),
      };
      const decision = decideAdmission(counts);
      const caps = capsFromFrozen(input.config);
      const build = await insertBuild(tx, {
        project: input.command.project,
        repository: input.command.repository,
        requestedByUserId: input.command.requesterUserId,
        clientRequestId: input.command.clientRequestId,
        prompt: input.command.prompt,
        modelOverride: input.command.model ?? null,
        skillSettingsId: input.settingsId,
        status: decision.status,
        queuedAt: decision.status === 'queued' ? nowIso : null,
        startedAt: decision.status === 'intake' ? nowIso : null,
        skillSnapshot: snapshotFromFrozen(input.config, input.command.model),
        supportContacts: contactsFromFrozen(input.config),
        qualityManifestSnapshot: caps.qualityManifestSnapshot,
        costCapUsd: caps.costCapUsd,
        elapsedCapSeconds: caps.elapsedCapSeconds,
        parallelismCap: caps.parallelismCap,
        revisionCap: caps.revisionCap,
      });
      return { build, replayed: false, queueReason: decision.queueReason };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await findBuildByClientRequest(
      input.command.project,
      input.command.requesterUserId,
      input.command.clientRequestId,
    );
    if (!winner) throw error;
    return { build: winner, replayed: true, queueReason: undefined };
  }
}

type AdmissionQueueReason = 'project_limit' | 'platform_limit' | null;

export function refusalOf(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof BuildStartError)) return null;
  const body: Record<string, unknown> = { error: error.message, code: error.code };
  if (error.refusals) body.refusals = error.refusals.map((refusal) => refusal.message);
  return { status: error.status, body };
}
