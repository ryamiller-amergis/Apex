import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

// Load the repo root .env so TEST_DATABASE_URL / DATABASE_URL can be defined
// there instead of being exported in every shell session. CI sets these as
// real environment variables, which take precedence over .env values.
dotenv.config();

/**
 * Resolve the E2E test database URL.
 * Resolution order:
 *   1. TEST_DATABASE_URL (env or .env) — explicit, used by CI.
 *   2. Derived from DATABASE_URL by appending _e2e to the database name.
 *   3. A local default.
 */
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  (process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, '/$1_e2e$2')
    : 'postgresql://test:test@localhost:5432/aipilot_e2e');

const e2eDataDir = path.join(os.tmpdir(), 'apex-e2e-data');

// ── Environment targeting ───────────────────────────────────────────────────
// The local full suite always runs against the Playwright-managed dev servers
// on 127.0.0.1:3000. The `deployed-smoke` project instead targets an
// already-running deployment (dev / staging / prod) via E2E_BASE_URL.
//
// When E2E_BASE_URL is set we are in "deployed target" mode:
//   - Playwright must NOT start/manage a local webServer (the site is remote).
//   - globalSetup skips migrations/DB seeding (see support/global-setup.ts) —
//     deployed environments own their own data and expose no /e2e/* endpoints.
//   - The `deployed-smoke` project is added so `--project=deployed-smoke` works.
// When E2E_BASE_URL is unset the project list, webServer, and setup are byte-for
// -byte identical to the original local-only configuration, so the local
// Tier 0 suite is completely unchanged.
const LOCAL_BASE_URL = 'http://127.0.0.1:3000';
const deployedBaseURL = process.env.E2E_BASE_URL ?? LOCAL_BASE_URL;
const isDeployedTarget = !!process.env.E2E_BASE_URL;

// ── Deployed-target authentication ──────────────────────────────────────────
// PRIMARY (dev + staging): fully-automated programmatic Azure AD SSO login.
// When E2E_TEST_USER + E2E_TEST_PASSWORD are present, a dedicated `setup`
// project (tests/e2e/support/auth.setup.ts) logs in against the real Entra
// login form each run and writes an EPHEMERAL storageState to
// tests/e2e/.auth/deployed.json. The `deployed-smoke` project then depends on
// `setup` and reuses that fresh session. No stored/secret session blob.
const hasSsoCreds = !!(process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD);
const deployedAuthFile = path.resolve(__dirname, 'tests/e2e/.auth/deployed.json');

// FALLBACK (optional, local only): a pre-captured SSO storageState via
// E2E_STORAGE_STATE (see tests/e2e/support/capture-storage-state.ts). Used only
// when no SSO credentials are provided. Prod runs with neither → unauthenticated
// @prod-safe. Never commit these files (tests/e2e/.auth/ is gitignored).
const storageStatePath = process.env.E2E_STORAGE_STATE || undefined;

// Session the deployed-smoke project consumes:
//   creds present → the ephemeral file produced fresh each run by `setup`
//   else          → optional E2E_STORAGE_STATE, or undefined (unauthenticated)
const deployedStorageState = hasSsoCreds ? deployedAuthFile : storageStatePath;

export default defineConfig({
  testDir: './tests/e2e/specs',

  // Run all tests serially to avoid seed data collisions on the shared test DB.
  fullyParallel: false,

  // Fail fast when test.only leaks into CI.
  forbidOnly: !!process.env.CI,

  // Retry on CI to surface genuine flakes rather than transient infrastructure noise.
  retries: process.env.CI ? 2 : 0,

  workers: 1,

  reporter: process.env.CI
    ? [
        ['junit', { outputFile: 'playwright-results/results.xml' }],
        ['html', { outputFolder: 'playwright-results/html', open: 'never' }],
        ['list'],
      ]
    : [['html'], ['list']],

  use: {
    // Use 127.0.0.1 (not "localhost") so the client always hits the IPv4
    // interface the dev servers bind to — avoids intermittent ECONNREFUSED on
    // Windows where "localhost" resolves to IPv6 (::1) first.
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    // Local full Tier 0 suite — seeds/wipes aipilot_e2e, uses /auth/dev-login.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Programmatic Azure AD SSO login. Registered only when we target a deployed
    // site AND have SSO credentials (dev + staging). It writes the ephemeral
    // storageState that `deployed-smoke` depends on. Never runs for prod (no
    // creds are passed there) or for the local suite.
    ...(isDeployedTarget && hasSsoCreds
      ? [
          {
            name: 'setup',
            testDir: path.resolve(__dirname, 'tests/e2e/support'),
            testMatch: /auth\.setup\.ts/,
            use: {
              ...devices['Desktop Chrome'],
              baseURL: deployedBaseURL,
            },
          },
        ]
      : []),
    // Read-only smoke against an already-deployed site (dev / staging / prod).
    // Only registered in deployed-target mode so the local suite's project list
    // is unchanged and @deployed-smoke tests never double-run locally.
    ...(isDeployedTarget
      ? [
          {
            name: 'deployed-smoke',
            grep: /@deployed-smoke/,
            // Dev + staging depend on the programmatic SSO `setup` project and
            // consume its fresh session. Prod passes no creds → no dependency,
            // no storageState → the @prod-safe subset runs unauthenticated.
            dependencies: hasSsoCreds ? ['setup'] : [],
            use: {
              ...devices['Desktop Chrome'],
              baseURL: deployedBaseURL,
              storageState: deployedStorageState,
            },
          },
        ]
      : []),
  ],

  globalSetup: path.resolve(__dirname, 'tests/e2e/support/global-setup.ts'),
  globalTeardown: path.resolve(__dirname, 'tests/e2e/support/global-teardown.ts'),

  // No webServer in deployed-target mode: the site is already running remotely.
  webServer: isDeployedTarget
    ? undefined
    : [
    {
      // Express API server running with E2E_MODE to suppress background services.
      command: 'ts-node -P tsconfig.server.json src/server/index.ts',
      port: 3001,
      reuseExistingServer: !process.env.CI,
      env: {
        E2E_MODE: 'true',
        NODE_ENV: 'test',
        PORT: '3001',
        DATABASE_URL: testDatabaseUrl,
        SESSION_SECRET: 'e2e-test-secret-not-for-production',
        AI_PILOT_DATA_DIR: e2eDataDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Vite dev server — proxies /api and /auth to Express on 3001.
      // --host 127.0.0.1 forces IPv4 binding to match baseURL.
      command: 'vite --config vite.config.ts --host 127.0.0.1',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      env: {
        VITE_TEAMS: 'false',
      },
    },
  ],
});
