import { and, eq } from 'drizzle-orm';

import { db } from '../../db/drizzle';
import { buildPreviewBrowserChecks } from '../../db/schema';
import type { BrowserCheckRepository } from './buildPreviewBrowserVerifier';

type Database = typeof db;

export function createDrizzleBrowserCheckRepository(
  database: Database = db
): BrowserCheckRepository {
  return {
    async createPending(input) {
      const [created] = await database
        .insert(buildPreviewBrowserChecks)
        .values({
          buildPreviewInstanceId: input.buildPreviewInstanceId,
          commit: input.commit,
          artifactDigest: input.artifactDigest,
          journeyVersion: input.journeyVersion,
          status: 'pending',
          evidenceRefs: [],
        })
        .returning({ id: buildPreviewBrowserChecks.id });

      if (!created) {
        throw new Error('Browser check could not be created.');
      }
      return created;
    },

    async complete(input) {
      const [completed] = await database
        .update(buildPreviewBrowserChecks)
        .set({
          status: input.status,
          evidenceRefs: input.evidenceRefs,
          consoleSummary: input.consoleSummary,
          networkSummary: input.networkSummary,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
        })
        .where(
          and(
            eq(buildPreviewBrowserChecks.id, input.id),
            eq(
              buildPreviewBrowserChecks.buildPreviewInstanceId,
              input.buildPreviewInstanceId
            ),
            eq(buildPreviewBrowserChecks.commit, input.commit),
            eq(buildPreviewBrowserChecks.artifactDigest, input.artifactDigest),
            eq(buildPreviewBrowserChecks.status, 'pending')
          )
        )
        .returning({ id: buildPreviewBrowserChecks.id });

      if (!completed) {
        throw new Error(
          'Browser check was stale, already complete, or had a different identity.'
        );
      }
    },
  };
}
