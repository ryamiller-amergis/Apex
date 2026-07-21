/**
 * Cross-platform filesystem, hashing, and determinism helpers.
 * Node built-ins only so the package runs via `npx` with no install step.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Normalize a path to forward slashes so lockfile keys are OS-independent. */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Normalize file text so output diffs are shell- and OS-independent:
 * strip BOM, convert CRLF/CR to LF, and ensure a single trailing newline.
 */
export function normalizeText(text) {
  let t = text.replace(/^\uFEFF/, '');
  t = t.replace(/\r\n?/g, '\n');
  if (!t.endsWith('\n')) t += '\n';
  return t;
}

/** SHA-256 of already-normalized text, hex encoded. */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 of a file's normalized contents. Returns null if missing. */
export function hashFile(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return sha256(normalizeText(fs.readFileSync(absPath, 'utf8')));
}

/** Deterministic JSON.stringify: object keys sorted recursively. */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(value[k]);
        return acc;
      }, {});
  }
  return value;
}

export function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

export function ensureDir(absDir) {
  fs.mkdirSync(absDir, { recursive: true });
}

/** Recursively list files under a dir as POSIX-relative paths (dir-relative). */
export function listFilesRel(absDir, { ignore = [] } = {}) {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      const rel = toPosix(path.relative(absDir, abs));
      if (ignore.some((ig) => rel === ig || rel.startsWith(ig + '/') || entry.name === ig)) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(absDir);
  return out.sort();
}

/** Write text to a path, creating parent dirs, after normalization. */
export function writeTextFile(absPath, text) {
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, normalizeText(text), 'utf8');
}

/** Guard against path traversal: resolvedTarget must stay within root. */
export function assertWithin(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, target);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${target}`);
  }
  return resolved;
}
