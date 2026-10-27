import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
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
  }
);
