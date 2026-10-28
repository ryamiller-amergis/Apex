import { defineTestProject } from '@project-scope/config/testing';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  defineTestProject({
    name: 'unit',
    environment: 'node',
  }) as Parameters<typeof mergeConfig>[0],
  defineConfig({
    test: {
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      setupFiles: ['./src/testing/setupTests.ts'],
    },
  })
);
