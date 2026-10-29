import { getUserPermissions } from '../rbacService';
import { isBuildFromPromptEnabled, isBuildPairAllowed } from '../buildAccessService';
import { isSuperAdminUserId } from '../../utils/superAdminUser';
import { startRun } from '../playbookRunService';
import { ensurePublished } from './provisioner';
import { promoteQueuedBuilds, type PromotionIo, type PromotionTx, type QueuedBuild } from './admission';
import {
  countSlots,
  linkPlaybookRun,
  listQueuedBuilds,
  markBuildFailed,
  markIntake,
  suspendQueued,
  withAdmissionLock,
  writeBuildEvent,
} from './store';

export async function promoteDueBuilds(): Promise<string[]> {
  return promoteQueuedBuilds(dbPromotionIo);
}

export async function onBuildSettled(_buildRunId: string): Promise<void> {
  await promoteDueBuilds();
}

const dbPromotionIo: PromotionIo = {
  transaction: (fn) => withAdmissionLock(async (tx) => fn(txAdapter(tx))),
  launch,
};

function txAdapter(tx: Parameters<Parameters<typeof withAdmissionLock>[0]>[0]): PromotionTx {
  return {
    lock: async () => undefined,
    listQueued: () => listQueuedBuilds(tx),
    projectSlots: (project) => countSlots(tx, project),
    platformSlots: () => countSlots(tx),
    checks: async (build) => ({
      flagOn: await isBuildFromPromptEnabled({ userId: build.requestedByUserId, project: build.project }),
      allowed: build.skillSettingsId !== null
        && await isBuildPairAllowed(build.project, build.repository),
      hasRunPermission: await requesterCanRun(build),
    }),
    markIntake: (id) => markIntake(tx, id),
    suspend: (id, reason) => suspendQueued(tx, id, reason),
  };
}

async function requesterCanRun(build: QueuedBuild): Promise<boolean> {
  if (await isSuperAdminUserId(build.requestedByUserId)) return true;
  const permissions = await getUserPermissions(build.requestedByUserId, build.project);
  return permissions.has('builds:run');
}

async function launch(build: QueuedBuild): Promise<void> {
  try {
    const published = await ensurePublished(build.project, build.requestedByUserId);
    await startRun({
      project: build.project,
      definitionId: published.definitionId,
      initiatorUserId: build.requestedByUserId,
      runInput: {
        buildRunId: build.id,
        prompt: build.prompt,
        skillSettingsId: build.skillSettingsId,
      },
      onRunCreated: (runId) => linkPlaybookRun(build.id, runId),
    });
    await writeBuildEvent({
      buildRunId: build.id,
      eventType: 'build.promoted',
      message: 'Build promoted from the queue',
      repository: build.repository,
      model: null,
      promptLength: build.prompt.length,
      actorUserId: build.requestedByUserId,
      dedupeKey: `build.promoted:${build.id}`,
    });
  } catch {
    await markBuildFailed(build.id);
    await writeBuildEvent({
      buildRunId: build.id,
      eventType: 'build.start_failed',
      message: 'Build failed to start',
      repository: build.repository,
      model: null,
      promptLength: build.prompt.length,
      actorUserId: build.requestedByUserId,
      dedupeKey: `build.start_failed:${build.id}`,
    });
  }
}
