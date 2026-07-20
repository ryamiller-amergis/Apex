/**
 * Custom Playwright test fixtures.
 *
 * Usage in specs:
 *   import { test, expect } from '../support/fixtures';
 *
 *   test('some scenario', async ({ page, loginAsPersona, e2eApi }) => {
 *     await loginAsPersona('ba');
 *     await page.goto('/');
 *     ...
 *   });
 */
import { test as base, request as requestLib } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { devLogin } from './auth';
import { SeedApi } from '../data/seed';

export type Persona = 'developer' | 'ba' | 'manager' | 'product-owner' | 'qa' | 'ui-ux';

/** OIDs from the dev-mock-seed migration — must match devMockUsers.ts */
export const PERSONA_OIDS: Record<Persona, string> = {
  developer: 'dev-mock-oid-00000000-0000-0000-0000-000000000000',
  ba: 'dev-mock-oid-00000000-0000-0000-0000-000000000001',
  manager: 'dev-mock-oid-00000000-0000-0000-0000-000000000002',
  'product-owner': 'dev-mock-oid-00000000-0000-0000-0000-000000000003',
  qa: 'dev-mock-oid-00000000-0000-0000-0000-000000000004',
  'ui-ux': 'dev-mock-oid-00000000-0000-0000-0000-000000000005',
};

/**
 * E2E test project name.
 * The dev-mock-seed migration assigns all personas to MaxView and MatterWorx.
 * Tests use MaxView; ADO calls to list its work items are stubbed via page.route().
 */
export const E2E_PROJECT = 'MaxView';

type E2EFixtures = {
  /** Log the current page session in as a specific dev persona. */
  loginAsPersona: (persona: Persona) => Promise<void>;

  /** Unauthenticated API request context pointing to the Express server. */
  e2eApi: APIRequestContext;
};

export const test = base.extend<E2EFixtures>({
  loginAsPersona: async ({ page }, use) => {
    await use(async (persona: Persona) => {
      // In deployed authenticated mode the browser context is already signed in
      // as the SSO test account — either via the programmatic SSO `setup` project
      // (E2E_TEST_USER/E2E_TEST_PASSWORD present) or an optional pre-captured
      // storageState (E2E_STORAGE_STATE). /auth/dev-login is gated off on those
      // NODE_ENV=production deployments and would 404, so skip it and reuse the
      // existing session.
      if (
        process.env.E2E_STORAGE_STATE ||
        (process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD)
      ) {
        return;
      }
      await devLogin(page, persona);
    });
  },

  e2eApi: async ({}, use) => {
    const ctx = await requestLib.newContext({ baseURL: 'http://127.0.0.1:3001' });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect } from '@playwright/test';
export { SeedApi };
