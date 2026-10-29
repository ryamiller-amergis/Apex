const config = {
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: ['default'],
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
  },
};

export default config;
