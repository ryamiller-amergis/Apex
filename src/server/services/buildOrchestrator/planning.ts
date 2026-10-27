import type { BuildStepOutput } from '../../../shared/types/playbook';
import { advanceRun } from '../playbookAdvanceService';
import { resumeStepRun } from '../playbookSteps/stepRuns';
import { beginPlanningRow, loadBuild } from './store';

export async function beginPlanning(buildRunId: string, stepRunId: string): Promise<boolean> {
  const row = await loadBuild(buildRunId);
  if (!row || row.status !== 'intake') return false;
  return beginPlanningRow(buildRunId, stepRunId);
}

export async function reportBuildTerminal(buildRunId: string, result: BuildStepOutput): Promise<void> {
  const row = await loadBuild(buildRunId);
  if (!row?.playbookStepRunId) return;
  const resumed = await resumeStepRun({
    stepRunId: row.playbookStepRunId,
    output: {
      buildRunId: result.buildRunId,
      status: result.status,
      ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
    },
  });
  if (!resumed || !row.playbookRunId) return;
  await advanceRun(row.playbookRunId);
}
