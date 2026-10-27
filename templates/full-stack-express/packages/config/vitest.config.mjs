import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.mjs';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts', '**/*.test.mjs'],
    },
  })
);
