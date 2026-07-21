/**
 * Terminology / glossary detector
 *
 * Looks for glossary definitions in common documentation files:
 *   - GLOSSARY.md, glossary.md
 *   - context.md, CONTEXT.md
 *   - AGENTS.md, agents.md
 *   - README.md (only if it contains a "## Glossary" or "## Terms" section)
 *
 * Also scans TypeScript enums for domain terms:
 *   export enum WorkItemState { Active = 'Active', Closed = 'Closed' }
 *
 * Emits evidence:
 *   { type: 'term',  name: 'PBI', definition: 'Product Backlog Item', file: 'context.md', line: 42 }
 *   { type: 'enum',  name: 'WorkItemState', member: 'Active', file: 'src/shared/types/workItem.ts', line: 5 }
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = ['context.md', 'CONTEXT.md', 'AGENTS.md', 'agents.md', 'GLOSSARY.md', 'glossary.md', 'README.md', 'docs/GLOSSARY.md'];
const TERM_RE    = /^\|\s*\*\*([^*|]+)\*\*\s*\|\s*([^|]+)\|/;
const HEADING_RE = /^##\s+(Glossary|Terms|Key Terms|Terminology|Key Terminology)/i;
const ENUM_RE    = /export\s+(?:const\s+)?enum\s+([A-Z][A-Za-z0-9_]+)\s*\{([^}]+)\}/g;
const ENUM_MEMBER_RE = /([A-Za-z0-9_]+)\s*[=:]\s*['"`]?([^'"`\n,}]+)['"`]?/g;
const MAX_TERMS  = 200;

/**
 * @param {string} repoRoot
 * @returns {Array<{type: string, name: string, definition?: string, member?: string, file: string, line: number}>}
 */
export function detectTerminology(repoRoot) {
  const evidence = [];

  // Markdown docs
  for (const rel of DOCS) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let text;
    try { text = readFileSync(abs, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    let inSection = false;
    lines.forEach((line, idx) => {
      if (HEADING_RE.test(line)) { inSection = true; return; }
      if (inSection && /^##\s+/.test(line)) { inSection = false; }
      if (inSection || rel.toLowerCase().includes('glossary') || rel.toLowerCase() === 'context.md') {
        const m = TERM_RE.exec(line);
        if (m) {
          evidence.push({ type: 'term', name: m[1].trim(), definition: m[2].trim(), file: rel, line: idx + 1 });
        }
      }
    });
    if (evidence.length >= MAX_TERMS) break;
  }

  // TypeScript enums in shared/types
  const enumDirs = ['src/shared/types', 'src/shared', 'shared/types', 'types'];
  for (const dir of enumDirs) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    const { readdirSync } = await import('node:fs').catch(() => ({}));
    // Use sync readdir
    let files;
    try {
      files = (await import('node:fs')).readdirSync(abs);
    } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
      const fp = join(abs, f);
      let src;
      try { src = readFileSync(fp, 'utf-8'); } catch { continue; }
      const rel = `${dir}/${f}`;
      ENUM_RE.lastIndex = 0;
      let em;
      while ((em = ENUM_RE.exec(src)) !== null) {
        const enumName = em[1];
        ENUM_MEMBER_RE.lastIndex = 0;
        let mm;
        while ((mm = ENUM_MEMBER_RE.exec(em[2])) !== null) {
          evidence.push({ type: 'enum', name: enumName, member: mm[1], value: mm[2].trim(), file: rel, line: 1 });
        }
      }
    }
    if (evidence.length >= MAX_TERMS * 2) break;
  }

  return evidence;
}
