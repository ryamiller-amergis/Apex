import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noHardcodedColor from './eslint/no-hardcoded-color.mjs';

const reactHooksConfig =
  reactHooks.configs?.flat?.recommended ??
  reactHooks.configs?.['recommended-latest'];
const jsxA11yConfig = jsxA11y.flatConfigs?.recommended;

if (!reactHooksConfig || !jsxA11yConfig) {
  throw new Error(
    'Expected flat recommended configs from react-hooks and jsx-a11y'
  );
}

const sharedTypeScriptRules = {
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
};

const scriptRules = {
  files: ['**/*.{js,mjs,cjs}'],
  rules: {
    'no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
};

const browserFiles = ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'];

const databaseImports = {
  paths: [
    {
      name: 'pg',
      message:
        'Only apps/api/src/persistence may import the database driver or Drizzle.',
    },
  ],
  patterns: [
    {
      group: ['drizzle-orm', 'drizzle-orm/*', 'drizzle-kit', 'drizzle-kit/*'],
      message:
        'Only apps/api/src/persistence may import the database driver or Drizzle.',
    },
  ],
};
const migrationRunnerImports = {
  group: ['**/persistence/migrations', '**/persistence/migrations/**'],
  message:
    'Only the migrate command and test support may import the migration runner.',
};

// Flat config replaces a rule per file rather than merging it, so each block
// lists every restriction that applies to its files.
const persistenceBoundaries = [
  {
    files: ['apps/api/**/*.ts'],
    ignores: [
      'apps/api/src/persistence/**',
      'apps/api/src/cli/**',
      'apps/api/scripts/**',
      'apps/api/test/**',
      'apps/api/drizzle.config.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...databaseImports,
          patterns: [...databaseImports.patterns, migrationRunnerImports],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/cli/**/*.ts', 'apps/api/scripts/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', databaseImports] },
  },
  {
    files: ['apps/api/src/persistence/**/*.ts'],
    ignores: ['apps/api/src/persistence/migrations/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [migrationRunnerImports] },
      ],
    },
  },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sharedTypeScriptRules,
  scriptRules,
  {
    files: browserFiles,
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    ...reactHooksConfig,
    files: browserFiles,
  },
  {
    ...jsxA11yConfig,
    files: browserFiles,
  },
  {
    files: [
      'apps/api/**/*.ts',
      'apps/api/**/*.mjs',
      'scripts/**/*.mjs',
      'packages/config/**/*.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', 'apps/api/test/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read process.env only in apps/api/src/config/env.ts.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.type="MetaProperty"][property.name="env"]',
          message: 'Read import.meta.env only in apps/web/src/config/env.ts.',
        },
      ],
    },
  },
  ...persistenceBoundaries,
  {
    files: ['apps/api/src/config/env.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['apps/web/src/config/env.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    ignores: [
      'packages/ui/src/tokens/**',
      'apps/web/src/theme/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    plugins: {
      'design-tokens': { rules: { 'no-hardcoded-color': noHardcodedColor } },
    },
    rules: {
      'design-tokens/no-hardcoded-color': 'error',
    },
  }
);
