// Shared test configuration. Coverage floors are defined only here.
// defineTestProject copies name and environment and drops every other field,
// so a member config cannot pass a local threshold through this helper.

export const coverageFloors = Object.freeze({
  lines: 80,
  functions: 80,
  statements: 80,
  branches: 75,
});

export const coverageScope = Object.freeze({
  include: Object.freeze([
    'apps/api/src/**',
    'apps/web/src/**',
    'packages/contracts/src/**',
    'packages/ui/src/**',
  ]),
  exclude: Object.freeze([
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.test.mjs',
    '**/*.d.ts',
    '**/*.config.*',
    '**/*.md',
    '**/openapi/**',
    '**/*.sql',
    'apps/api/src/persistence/migrations/**',
    'apps/api/src/persistence/seed/**',
    'apps/web/src/testing/**',
    'packages/ui/src/testing/**',
  ]),
});

const PROJECTS = new Set([
  'unit',
  'component',
  'api',
  'integration',
  'contract',
]);

export function defineTestProject(options) {
  const name = options?.name;
  const environment = options?.environment;
  if (!PROJECTS.has(name)) {
    throw new Error(
      `defineTestProject: name must be unit, component, api, integration, or contract`
    );
  }
  if (environment !== 'node' && environment !== 'jsdom') {
    throw new Error('defineTestProject: environment must be node or jsdom');
  }
  return {
    test: {
      name,
      environment,
      reporters: ['default'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
      testTimeout: name === 'integration' ? 30_000 : 10_000,
      hookTimeout: name === 'integration' ? 120_000 : 10_000,
    },
  };
}

// Playwright defaults. The config reads no CI variable (BR-013).
export const playwrightBase = Object.freeze({
  testDir: '.',
  testMatch: ['e2e/specs/**/*.spec.ts', 'apps/web/e2e/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: Object.freeze({
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  }),
  projects: Object.freeze([
    Object.freeze({
      name: 'chromium',
      use: Object.freeze({ browserName: 'chromium' }),
    }),
  ]),
  webServer: Object.freeze({
    command: 'node e2e/support/start-stack.mjs',
    url: 'http://127.0.0.1:4173/health/live',
    timeout: 120_000,
    reuseExistingServer: false,
  }),
});
