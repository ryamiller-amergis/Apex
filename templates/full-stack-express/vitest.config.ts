import {
  coverageFloors,
  coverageScope,
  defineTestProject,
} from './packages/config/testing.mjs';
import { defineConfig } from 'vitest/config';

function project(name, environment, extra) {
  const base = defineTestProject({ name, environment });
  return {
    test: {
      ...base.test,
      ...extra,
    },
  };
}

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [...coverageScope.include],
      exclude: [...coverageScope.exclude],
      thresholds: {
        lines: coverageFloors.lines,
        functions: coverageFloors.functions,
        statements: coverageFloors.statements,
        branches: coverageFloors.branches,
      },
    },
    projects: [
      project('unit', 'node', {
        include: ['**/*.test.ts', 'packages/config/**/*.test.mjs'],
        exclude: [
          '**/node_modules/**',
          '**/dist/**',
          '**/coverage/**',
          'apps/api/test/api/**',
          'apps/api/test/integration/**',
          'apps/api/test/contract/**',
          'e2e/**',
          'scripts/__tests__/**',
        ],
      }),
      project('component', 'jsdom', {
        include: ['apps/web/**/*.test.tsx', 'packages/ui/**/*.test.tsx'],
        setupFiles: [
          './packages/ui/src/testing/setupTests.ts',
          './apps/web/src/testing/setupTests.ts',
        ],
      }),
      project('api', 'node', {
        include: ['apps/api/test/api/**/*.api.test.ts'],
      }),
      project('integration', 'node', {
        include: ['apps/api/test/integration/**/*.integration.test.ts'],
        globalSetup: ['./apps/api/test/integration/globalSetup.ts'],
        fileParallelism: false,
      }),
      project('contract', 'node', {
        include: ['apps/api/test/contract/**/*.contract.test.ts'],
      }),
    ],
  },
});
