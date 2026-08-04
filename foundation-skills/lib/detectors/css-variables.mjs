/**
 * CSS-variable / design-token detector
 *
 * Scans for CSS custom properties (--token-name: value) in:
 *   - *.module.css  *.css  *.scss
 *   - src/client/**  public/**  styles/**
 *
 * Emits evidence entries:
 *   { type: 'css-variable', name: '--primary-color', value: '#1976d2', file: 'src/...css', line: 5 }
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const CSS_EXTS   = new Set(['.css', '.scss', '.less']);
const IGNORE_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.apex']);
const VAR_RE     = /--([a-zA-Z0-9_-]+)\s*:\s*([^;}\n]+)/g;
const MAX_FILES  = 500;

function* walkCss(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (IGNORE_DIR.has(e.name)) continue;
      const full = join(current, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (CSS_EXTS.has(extname(e.name))) {
        yield full;
        if (++count >= MAX_FILES) return;
      }
    }
  }
}

/**
 * @param {string} repoRoot
 * @returns {Array<{type: string, name: string, value: string, file: string, line: number}>}
 */
export function detectCssVariables(repoRoot) {
  const evidence = [];
  const seen = new Set();

  for (const absPath of walkCss(repoRoot)) {
    let content;
    try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }
    const relFile = absPath.replace(repoRoot + '/', '').replace(repoRoot + '\\', '');

    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      VAR_RE.lastIndex = 0;
      let match;
      while ((match = VAR_RE.exec(line)) !== null) {
        const name  = `--${match[1]}`;
        const value = match[2].trim();
        if (!seen.has(name)) {
          seen.add(name);
          evidence.push({ type: 'css-variable', name, value, file: relFile, line: idx + 1 });
        }
      }
    });
  }

  return evidence;
}
