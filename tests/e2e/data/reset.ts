/**
 * Standalone database reset script for interrupted local E2E runs.
 *
 * Usage:
 *   npm run test:e2e:reset-db
 *
 * This cleans up [E2E]-prefixed records that a Playwright run left behind
 * (e.g., after Ctrl-C). Safe to run against the test database at any time.
 */
import 'dotenv/config';

async function main(): Promise<void> {
  const dbUrl =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL
      ? process.env.DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, '/$1_e2e$2')
      : '');

  if (!dbUrl) {
    console.error('[E2E reset] TEST_DATABASE_URL or DATABASE_URL must be set.');
    process.exit(1);
  }

  // Import here so the pool uses the env var we just validated.
  process.env.DATABASE_URL = dbUrl;

  const { db } = await import('../../../src/server/db/drizzle');
  const {
    notifications,
    reviewComments,
    prds,
    interviews,
    designDocs,
    designPrototypes,
    documentApproverAssignments,
    chatThreads,
    projectSkillSettings,
  } = await import('../../../src/server/db/schema');
  const { like, inArray } = await import('drizzle-orm');

  console.log('[E2E reset] Removing E2E test records...');

  const deletedComments = await db
    .delete(reviewComments)
    .where(like(reviewComments.body, '[E2E]%'))
    .returning({ id: reviewComments.id });
  const deletedNotifs = await db
    .delete(notifications)
    .where(like(notifications.title, '[E2E]%'))
    .returning({ id: notifications.id });

  const e2ePrds = await db.select({ id: prds.id }).from(prds).where(like(prds.title, '[E2E]%'));
  const e2eDocs = await db.select({ id: designDocs.id }).from(designDocs).where(like(designDocs.title, '[E2E]%'));
  const e2eProtos = await db
    .select({ id: designPrototypes.id })
    .from(designPrototypes)
    .where(like(designPrototypes.featureName, '[E2E]%'));
  const documentIds = [
    ...e2ePrds.map((r) => r.id),
    ...e2eDocs.map((r) => r.id),
    ...e2eProtos.map((r) => r.id),
  ];
  let deletedAssignments = 0;
  if (documentIds.length > 0) {
    const rows = await db
      .delete(documentApproverAssignments)
      .where(inArray(documentApproverAssignments.documentId, documentIds))
      .returning({ id: documentApproverAssignments.id });
    deletedAssignments = rows.length;
  }

  const deletedPrds = await db.delete(prds).where(like(prds.title, '[E2E]%')).returning({ id: prds.id });
  const deletedDocs = await db
    .delete(designDocs)
    .where(like(designDocs.title, '[E2E]%'))
    .returning({ id: designDocs.id });
  const deletedProtos = await db
    .delete(designPrototypes)
    .where(like(designPrototypes.featureName, '[E2E]%'))
    .returning({ id: designPrototypes.id });

  const e2eInterviews = await db
    .select({ id: interviews.id, chatThreadId: interviews.chatThreadId })
    .from(interviews)
    .where(like(interviews.title, '[E2E]%'));
  const deletedInterviews = await db
    .delete(interviews)
    .where(like(interviews.title, '[E2E]%'))
    .returning({ id: interviews.id });

  const threadIds = e2eInterviews.map((i) => i.chatThreadId);
  const e2eThreads = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(like(chatThreads.title, '[E2E]%'));
  const allThreadIds = [...new Set([...threadIds, ...e2eThreads.map((t) => t.id)])];
  let deletedThreads = 0;
  if (allThreadIds.length > 0) {
    const rows = await db
      .delete(chatThreads)
      .where(inArray(chatThreads.id, allThreadIds))
      .returning({ id: chatThreads.id });
    deletedThreads = rows.length;
  }

  const deletedSettings = await db
    .delete(projectSkillSettings)
    .where(like(projectSkillSettings.friendlyName, '[E2E]%'))
    .returning({ id: projectSkillSettings.id });

  console.log(
    `[E2E reset] Removed: ${deletedComments.length} comments, ` +
      `${deletedNotifs.length} notifications, ${deletedAssignments} assignments, ` +
      `${deletedPrds.length} PRDs, ${deletedDocs.length} design docs, ` +
      `${deletedProtos.length} prototypes, ${deletedInterviews.length} interviews, ` +
      `${deletedThreads} threads, ${deletedSettings.length} project settings.`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('[E2E reset] Unexpected error:', err);
  process.exit(1);
});
