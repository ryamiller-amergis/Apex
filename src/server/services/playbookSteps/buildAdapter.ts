import { isBuildFromPromptEnabled, isBuildPairAllowed } from '../buildAccessService';
import { BUILD_STEP_DEADLINE_MS, resolveDeadlineMs } from './registry';
import { deadlineFromNow, suspendStepRun, type PlaybookStepExecutionContext, type PlaybookStepOutcome } from './stepRuns';
import { beginPlanning } from '../buildOrchestrator/planning';
import { loadBuild } from '../buildOrchestrator/store';
import { BuildStepRefusedError } from '../buildOrchestrator/errors';

const STEP_TYPE = 'build';

export async function executeBuildStep(context: PlaybookStepExecutionContext): Promise<PlaybookStepOutcome> {
  const buildRunId = stringField(context.config, 'buildRunId');
  const row = await loadBuild(buildRunId);
  if (!row) throw new BuildStepRefusedError('The build for this step does not exist.');
  if (row.project !== context.project || row.playbookRunId !== context.runId) {
    throw new BuildStepRefusedError('This build is not part of the current Playbook run.');
  }

  if (row.status !== 'intake') {
    if (row.playbookStepRunId === context.stepRunId) {
      return { kind: 'suspended', expiresAt: deadlineFromNow(BUILD_STEP_DEADLINE_MS) };
    }
    throw new BuildStepRefusedError('This build has already left intake.');
  }

  const enabled = await isBuildFromPromptEnabled({
    userId: context.initiatorUserId,
    project: context.project,
  });
  if (!enabled) throw new BuildStepRefusedError('Builds are turned off for this project.');
  if (!(await isBuildPairAllowed(context.project, row.repository))) {
    throw new BuildStepRefusedError('That repository is no longer approved for builds.');
  }

  const expiresAt = deadlineFromNow(resolveDeadlineMs(STEP_TYPE));
  await suspendStepRun({
    stepRunId: context.stepRunId,
    expiresAt,
    resumeToken: buildRunId,
  });
  await beginPlanning(buildRunId, context.stepRunId);
  return { kind: 'suspended', expiresAt };
}

function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BuildStepRefusedError(`Build step is missing ${key}.`);
  }
  return value;
}
