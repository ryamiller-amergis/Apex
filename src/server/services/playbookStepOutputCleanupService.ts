import { isNotNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookStepRuns } from '../db/schema';
import {
  createPlaybookStepOutputStore,
  type PlaybookStepOutputStore,
} from './playbookStepOutputStore';

const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface PlaybookStepOutputReconciliation {
  checkedReferences: number;
  danglingReferences: Array<{ stepRunId: string; key: string; error: string }>;
  deletedOrphans: string[];
}

/**
 * Verifies every durable reference and removes only unreferenced objects older than the upload-to-
 * database grace period. The grace prevents a sweep from deleting a blob between its upload and
 * the conditional step completion write.
 */
export async function reconcilePlaybookStepOutputs(options?: {
  store?: PlaybookStepOutputStore;
  now?: number;
}): Promise<PlaybookStepOutputReconciliation> {
  const store = options?.store ?? createPlaybookStepOutputStore();
  const now = options?.now ?? Date.now();
  const rows = await db
    .select({
      stepRunId: playbookStepRuns.id,
      reference: playbookStepRuns.outputBlobRef,
    })
    .from(playbookStepRuns)
    .where(isNotNull(playbookStepRuns.outputBlobRef));

  const referenced = new Set<string>();
  const danglingReferences: PlaybookStepOutputReconciliation['danglingReferences'] = [];
  for (const row of rows) {
    if (!row.reference) continue;
    referenced.add(row.reference.key);
    try {
      const envelope = await store.load(row.reference);
      if (envelope.stepRunId !== row.stepRunId) {
        throw new Error('envelope names a different step run');
      }
    } catch (error) {
      danglingReferences.push({
        stepRunId: row.stepRunId,
        key: row.reference.key,
        error: error instanceof Error ? error.message : 'verification failed',
      });
    }
  }

  const deletedOrphans: string[] = [];
  for (const candidate of await store.listKeys()) {
    if (
      !referenced.has(candidate.key)
      && now - candidate.lastModifiedMs >= ORPHAN_GRACE_MS
    ) {
      await store.delete({
        schemaVersion: 1,
        container: 'playbook-step-outputs',
        key: candidate.key,
        sha256: '0'.repeat(64),
        sizeBytes: 0,
        contentType: 'application/json',
      });
      deletedOrphans.push(candidate.key);
    }
  }

  return {
    checkedReferences: rows.length,
    danglingReferences,
    deletedOrphans,
  };
}
