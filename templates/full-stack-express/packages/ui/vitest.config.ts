import base from '@project-scope/config/vitest';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  base as Parameters<typeof mergeConfig>[0],
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/testing/setupTests.ts'],
    },
  })
);
