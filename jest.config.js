const tsJest = (tsconfig) => [
  'ts-jest',
  {
    tsconfig,
    // Type-check stays on `tsc --noEmit` (dev-orchestrator F5/F6, CI).
    diagnostics: false,
  },
];

module.exports = {
  projects: [
    {
      displayName: 'server',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/server/**/__tests__/**/*.ts'],
      transform: {
        '^.+\\.tsx?$': tsJest('<rootDir>/tsconfig.jest.server.json'),
      },
    },
    {
      displayName: 'client',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/src/client/**/__tests__/**/*.tsx', '<rootDir>/src/client/**/__tests__/**/*.ts'],
      moduleNameMapper: {
        '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
      },
      setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
      transform: {
        '^.+\\.tsx?$': tsJest('<rootDir>/tsconfig.jest.client.json'),
      },
    },
  ],
};
