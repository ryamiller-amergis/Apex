import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ui from './index.js';

const runtimeExports = [
  'tokens',
  'mergeTokens',
  'createAppTheme',
  'AppThemeProvider',
  'COLOR_MODE_STORAGE_KEY',
  'useColorMode',
  'checkThemeContrast',
  'CONTRAST_PAIRINGS',
  'formatContrastFailure',
  'AppShell',
  'AppErrorBoundary',
  'APP_ERROR_MESSAGE',
  'LoadingState',
  'EmptyState',
  'ErrorState',
  'testId',
  'TEST_ID_PATTERN',
];

describe('public API', () => {
  it('S10 exports the documented runtime surface from one entry point', () => {
    expect(Object.keys(ui).sort()).toEqual([...runtimeExports].sort());
  });

  it('TBI-021 DoD-2 README documents every export, the override recipe, and the selector convention', () => {
    const readme = readFileSync(
      path.resolve(import.meta.dirname, '../README.md'),
      'utf8'
    );
    for (const name of runtimeExports) {
      expect(readme).toContain(`\`${name}\``);
    }
    expect(readme).toMatch(/## Override tokens/);
    expect(readme).toMatch(/## Test selector convention/);
    expect(readme).toContain('check:contrast');
    for (const id of [
      'app-shell',
      'app-shell-header',
      'app-shell-skip-link',
      'app-shell-menu-button',
      'app-shell-nav',
      'app-shell-nav-item-{id}',
      'app-shell-color-mode-toggle',
      'app-shell-main',
      'loading-state',
      'empty-state',
      'empty-state-action',
      'error-state',
      'error-state-retry',
    ]) {
      expect(readme).toContain(`\`${id}\``);
    }
  });
});
