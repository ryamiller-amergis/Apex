/**
 * Shared detector library. Each detector is deterministic, reads only files
 * provided by the bounded scan context, and returns evidence entries of shape:
 *
 *   { key, value, source: { file, line? }, detector }
 *
 * Detectors never invent values; every entry is backed by a real file location.
 * Recipes compose these detectors via a declarative slot-map (see template.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './util.mjs';

function readLines(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

function entry(detector, key, value, file, line) {
  return { detector, key, value, source: line ? { file, line } : { file } };
}

/** CSS custom-property extractor: `--token: value;` across stylesheet files. */
export function detectCssVariables(ctx) {
  const out = [];
  const files = ctx.files.filter((f) => /\.(css|scss|less)$/i.test(f));
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i])) !== null) {
        out.push(entry('css-variables', m[1].trim(), m[2].trim(), rel, i + 1));
      }
    }
  }
  return dedupeByKey(out);
}

/** Component index: names of component files under a components directory. */
export function detectComponents(ctx) {
  const out = [];
  const files = ctx.files.filter(
    (f) => /(^|\/)components\//i.test(f) && /\.(tsx|jsx)$/.test(f),
  );
  for (const rel of files) {
    const base = path.basename(rel).replace(/\.(tsx|jsx)$/, '');
    if (/^[A-Z]/.test(base)) out.push(entry('components', base, rel, rel));
  }
  return dedupeByKey(out);
}

/** Route/module map: string literals passed to route path props/definitions. */
export function detectRoutes(ctx) {
  const out = [];
  const files = ctx.files.filter((f) => /\.(tsx|jsx|ts)$/.test(f));
  const re = /path\s*[:=]\s*["'`](\/[^"'`]*)["'`]/g;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i])) !== null) {
        out.push(entry('routes', m[1], m[1], rel, i + 1));
      }
    }
  }
  return dedupeByKey(out);
}

/** Package/stack reader: name, framework signals, scripts from package.json. */
export function detectStack(ctx) {
  const out = [];
  const pkgRel = ctx.files.find((f) => f === 'package.json');
  if (!pkgRel) return out;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, pkgRel), 'utf8'));
  } catch {
    return out;
  }
  if (pkg.name) out.push(entry('stack', 'projectName', pkg.name, pkgRel));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const known = ['react', 'vue', 'svelte', 'express', 'next', 'vite', '@mui/material', 'tailwindcss'];
  for (const dep of known) {
    if (deps[dep]) out.push(entry('stack', `dep:${dep}`, deps[dep], pkgRel));
  }
  return out;
}

/**
 * Terminology/glossary extractor: markdown table rows "| Term | Meaning |"
 * from any glossary/context doc. Pure structural parse, no inference.
 */
export function detectGlossary(ctx) {
  const out = [];
  const files = ctx.files.filter((f) => /\.md$/i.test(f) && /(context|glossary|agents)/i.test(f));
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const m = rowRe.exec(lines[i]);
      if (!m) continue;
      const term = m[1].trim();
      const meaning = m[2].trim();
      if (/^-+$/.test(term) || /term/i.test(term) === false && meaning.length < 3) continue;
      if (/^-+$/.test(meaning)) continue;
      out.push(entry('glossary', term, meaning, rel, i + 1));
    }
  }
  return dedupeByKey(out);
}

/** Directory-convention detector: top-level source directories. */
export function detectDirConventions(ctx) {
  const out = [];
  const dirs = new Set();
  for (const f of ctx.files) {
    const top = f.split('/').slice(0, 2).join('/');
    if (top.startsWith('src/')) dirs.add(top);
  }
  for (const d of [...dirs].sort()) {
    out.push(entry('dir-conventions', d, d, toPosix(d) + '/'));
  }
  return out;
}

function dedupeByKey(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (!seen.has(e.key)) seen.set(e.key, e);
  }
  return [...seen.values()];
}

export const DETECTORS = {
  'css-variables': detectCssVariables,
  components: detectComponents,
  routes: detectRoutes,
  stack: detectStack,
  glossary: detectGlossary,
  'dir-conventions': detectDirConventions,
};

export function runDetector(name, ctx) {
  const fn = DETECTORS[name];
  if (!fn) throw new Error(`Unknown detector: ${name}`);
  return fn(ctx);
}
