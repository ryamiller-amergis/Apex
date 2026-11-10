import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { buildRuns, playbookRuns } from '../../db/schema';

/**
 * Cancels the Playbook run behind a build. A build's Playbook run stays
 * suspended on its build step, and each project allows only a limited number
 * of suspended runs, so an ended build must release its run.
 */
export async function cancelBuildPlaybookRun(
  playbookRunId: string,
  requesterUserId: string
): Promise<void> {
  const [row] = await db
    .select({ project: playbookRuns.project, status: playbookRuns.status })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, playbookRunId))
    .limit(1);
  if (!row || !['running', 'suspended'].includes(row.status)) return;
  const { cancelPlaybookRun } = await import('../playbookRunActionService');
  await cancelPlaybookRun({
    runId: playbookRunId,
    project: row.project,
    actorUserId: requesterUserId,
    reason: 'The build ended.',
  });
}

/** Releases Playbook runs still parked for builds that were cancelled or failed. */
export async function releasePlaybookRunsOfEndedBuilds(): Promise<number> {
  const rows = await db
    .select({
      playbookRunId: playbookRuns.id,
      requesterUserId: buildRuns.requestedByUserId,
    })
    .from(buildRuns)
    .innerJoin(playbookRuns, eq(playbookRuns.id, buildRuns.playbookRunId))
    .where(
      and(
        inArray(buildRuns.status, ['cancelled', 'failed']),
        inArray(playbookRuns.status, ['running', 'suspended'])
      )
    )
    .limit(25);

  let released = 0;
  for (const row of rows) {
    try {
      await cancelBuildPlaybookRun(row.playbookRunId, row.requesterUserId);
      released += 1;
    } catch (error) {
      console.warn('[build-dispatch] could not release the Playbook run of an ended build', {
        playbookRunId: row.playbookRunId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return released;
}
