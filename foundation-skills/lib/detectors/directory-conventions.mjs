/**
 * Directory-conventions detector
 *
 * Infers naming, casing, and structural conventions from the repo layout.
 *
 * Emits evidence:
 *   { type: 'convention', key: 'componentDir',    value: 'src/client/components', file: '.', line: 1 }
 *   { type: 'convention', key: 'serverDir',       value: 'src/server',            file: '.', line: 1 }
 *   { type: 'convention', key: 'migrationDir',    value: 'migrations',            file: '.', line: 1 }
 *   { type: 'convention', key: 'cssModules',      value: 'true',                  file: '.', line: 1 }
 *   { type: 'convention', key: 'casing',          value: 'PascalCase',            file: '.', line: 1 }
 *   { type: 'convention', key: 'testDir',         value: 'src/.../__tests__',     file: '.', line: 1 }
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROBE_DIRS = [
  ['src/client/components', 'componentDir'],
  ['src/client/hooks',      'hookDir'],
  ['src/server/services',   'serviceDir'],
  ['src/server/routes',     'routeDir'],
  ['src/server/db',         'dbDir'],
  ['src/shared/types',      'sharedTypesDir'],
  ['migrations',            'migrationDir'],
  ['src/server',            'serverDir'],
  ['src/client',            'clientDir'],
  ['ClientApp/js/components', 'componentDir'],
  ['ClientApp/js/apis',       'apiDir'],
];

/**
 * @param {string} repoRoot
 * @returns {Array<{type: string, key: string, value: string, file: string, line: number}>}
 */
export function detectConventions(repoRoot) {
  const evidence = [];

  for (const [rel, key] of PROBE_DIRS) {
    if (existsSync(join(repoRoot, rel))) {
      evidence.push({ type: 'convention', key, value: rel, file: '.', line: 1 });
    }
  }

  // Check for CSS Modules (*.module.css files)
  const hasCssModules = evidence.some(e => e.key === 'componentDir') &&
    (() => {
      try {
        const dir = join(repoRoot, evidence.find(e => e.key === 'componentDir')?.value ?? '');
        const files = readdirSync(dir);
        return files.some(f => f.endsWith('.module.css'));
      } catch { return false; }
    })();
  if (hasCssModules) evidence.push({ type: 'convention', key: 'cssModules', value: 'true', file: '.', line: 1 });

  // Check naming conventions of component files
  const compDir = evidence.find(e => e.key === 'componentDir');
  if (compDir) {
    try {
      const files = readdirSync(join(repoRoot, compDir.value));
      const pascal = files.filter(f => /^[A-Z]/.test(f)).length;
      const kebab  = files.filter(f => /^[a-z].*-/.test(f)).length;
      if (pascal > kebab) evidence.push({ type: 'convention', key: 'casing', value: 'PascalCase', file: '.', line: 1 });
      else if (kebab > pascal) evidence.push({ type: 'convention', key: 'casing', value: 'kebab-case', file: '.', line: 1 });
    } catch { /* no-op */ }
  }

  // Test directory pattern
  const testPatterns = [
    ['src/server/__tests__',   '__tests__'],
    ['src/client/components/__tests__', '__tests__'],
  ];
  for (const [dir, pattern] of testPatterns) {
    if (existsSync(join(repoRoot, dir))) {
      evidence.push({ type: 'convention', key: 'testDir', value: pattern, file: '.', line: 1 });
      break;
    }
  }

  return evidence;
}
