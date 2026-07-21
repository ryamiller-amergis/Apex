/**
 * Component index detector
 *
 * Discovers UI component files and their exported names.
 * Looks for: src/client/components/, src/components/, components/, app/components/
 *
 * Emits evidence:
 *   { type: 'component', name: 'Button', file: 'src/client/components/Button.tsx', line: 1 }
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const COMP_DIRS    = ['src/client/components', 'src/components', 'components', 'app/components', 'ClientApp/js/components'];
const UI_EXTS      = new Set(['.tsx', '.jsx', '.vue', '.svelte']);
const IGNORE_DIR   = new Set(['node_modules', '.git', '__tests__', '__mocks__', 'dist', 'build', '.apex']);
const EXPORT_RE    = /export\s+(?:default\s+)?(?:function|class|const|let)\s+([A-Z][A-Za-z0-9_]*)/;
const MAX_COMP     = 200;

/**
 * @param {string} repoRoot
 * @returns {Array<{type: string, name: string, file: string, line: number}>}
 */
export function detectComponents(repoRoot) {
  const evidence = [];

  for (const dir of COMP_DIRS) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;

    const stack = [abs];
    let count = 0;
    while (stack.length && count < MAX_COMP) {
      const current = stack.pop();
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (IGNORE_DIR.has(e.name)) continue;
        const full = join(current, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!UI_EXTS.has(extname(e.name))) continue;

        const relFile = full.replace(repoRoot + '/', '').replace(repoRoot + '\\', '');
        const compName = basename(e.name, extname(e.name));
        if (!/^[A-Z]/.test(compName)) continue; // skip lowercase utility files

        let exportName = compName;
        try {
          const text = readFileSync(full, 'utf-8');
          const m = EXPORT_RE.exec(text);
          if (m) exportName = m[1];
        } catch { /* use filename-derived name */ }

        evidence.push({ type: 'component', name: exportName, file: relFile, line: 1 });
        if (++count >= MAX_COMP) break;
      }
    }
  }

  return evidence;
}
