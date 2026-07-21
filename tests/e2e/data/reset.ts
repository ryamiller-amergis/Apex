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
  const { notifications, reviewComments, prds } = await import('../../../src/server/db/schema');
  const { like } = await import('drizzle-orm');

  console.log('[E2E reset] Removing E2E test records...');

  const [deletedComments, deletedNotifs, deletedPrds] = await Promise.all([
    db.delete(reviewComments).where(like(reviewComments.body, '[E2E]%')).returning({ id: reviewComments.id }),
    db.delete(notifications).where(like(notifications.title, '[E2E]%')).returning({ id: notifications.id }),
    db.delete(prds).where(like(prds.title, '[E2E]%')).returning({ id: prds.id }),
  ]);

  console.log(
    `[E2E reset] Removed: ${deletedComments.length} comments, ` +
    `${deletedNotifs.length} notifications, ${deletedPrds.length} PRDs.`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error('[E2E reset] Unexpected error:', err);
  process.exit(1);
});
