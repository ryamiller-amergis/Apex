import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  '.git',
]);

function matches(name) {
  if (name.startsWith('vitest.config.')) {
    return true;
  }
  return name.startsWith('vitest.') && name.endsWith('.ts');
}

export function listVitestConfigFiles(root) {
  const found = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) {
        continue;
      }
      const full = path.join(dir, name);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (matches(name)) {
        found.push(full);
      }
    }
  }
  walk(root);
  return found.sort();
}

/**
 * Fails when a Vitest config other than the workspace-root vitest.config.ts
 * contains a thresholds key. That is the in-feature check for a package that
 * lowers a floor locally. The manifest validator (VT-12) is FEAT-012.
 */
export function scanCoverageThresholds(root) {
  const problems = [];
  const rootConfig = path.resolve(root, 'vitest.config.ts');
  for (const file of listVitestConfigFiles(root)) {
    const text = readFileSync(file, 'utf8');
    if (!/\bthresholds\b/.test(text)) {
      continue;
    }
    if (path.resolve(file) === rootConfig) {
      continue;
    }
    problems.push(
      `${path.relative(root, file)} sets a thresholds key and does not use the shared floors`
    );
  }
  return problems;
}
