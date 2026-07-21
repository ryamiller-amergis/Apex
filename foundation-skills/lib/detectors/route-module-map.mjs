/**
 * Route / module map detector
 *
 * Discovers Express route handlers, React Router routes, and Next.js/Vite
 * page files to build a list of feature areas.
 *
 * Emits evidence:
 *   { type: 'route', path: '/api/users', method: 'GET', file: 'src/server/routes/users.ts', line: 12 }
 *   { type: 'page',  path: '/dashboard', file: 'src/client/App.tsx', line: 45 }
 *   { type: 'module', name: 'UserManagement', file: 'src/client/components/AdminUsers.tsx', line: 1 }
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const IGNORE_DIR  = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.apex']);
const ROUTER_RE   = /router\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const ROUTE_COMP  = /path\s*[=:]\s*['"`]([/][^'"`]+)['"`]/g;
const LAZY_COMP   = /import\s*\(\s*['"`]\.\/components\/([A-Z][A-Za-z0-9]+)/g;
const MAX_FILES   = 300;

function* walkTs(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (IGNORE_DIR.has(e.name)) continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      const ext = extname(e.name);
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
        yield full;
        if (++count >= MAX_FILES) return;
      }
    }
  }
}

/**
 * @param {string} repoRoot
 * @returns {Array<{type: string, path?: string, method?: string, name?: string, file: string, line: number}>}
 */
export function detectRoutes(repoRoot) {
  const evidence = [];

  for (const abs of walkTs(repoRoot)) {
    let text;
    try { text = readFileSync(abs, 'utf-8'); } catch { continue; }
    const relFile = abs.replace(repoRoot + '/', '').replace(repoRoot + '\\', '');
    const lines = text.split('\n');

    // Express routes
    ROUTER_RE.lastIndex = 0;
    let m;
    while ((m = ROUTER_RE.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      evidence.push({ type: 'route', path: m[2], method: m[1].toUpperCase(), file: relFile, line: lineNo });
    }

    // React Router <Route path=
    ROUTE_COMP.lastIndex = 0;
    while ((m = ROUTE_COMP.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      evidence.push({ type: 'page', path: m[1], file: relFile, line: lineNo });
    }

    // Lazy-loaded components (feature modules)
    LAZY_COMP.lastIndex = 0;
    while ((m = LAZY_COMP.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      evidence.push({ type: 'module', name: m[1], file: relFile, line: lineNo });
    }
  }

  return evidence;
}
