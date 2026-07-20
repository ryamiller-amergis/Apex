/**
 * Playwright global teardown — runs once after all specs complete.
 *
 * Each spec resets its own seed data in afterEach, so global teardown is
 * intentionally minimal. CI environments are ephemeral and the test DB is
 * discarded after the run.
 */
export default async function globalTeardown(): Promise<void> {
  console.log('[E2E] Global teardown complete.');
}
