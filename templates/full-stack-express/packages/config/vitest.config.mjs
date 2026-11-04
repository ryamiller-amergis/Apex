import { defineConfig, mergeConfig } from 'vitest/config';
import { defineTestProject } from './testing.mjs';

export default mergeConfig(
  defineTestProject({ name: 'unit', environment: 'node' }),
  defineConfig({
    test: {
      include: ['**/*.test.mjs'],
    },
  })
);
