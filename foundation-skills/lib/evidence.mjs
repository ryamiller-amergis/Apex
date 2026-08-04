/**
 * Stage A: deterministic evidence collection.
 *
 * Builds a bounded file list for a skill's declared scanScope, runs the recipe's
 * detectors, and returns { entries, meta }. Every entry carries a real file
 * source. Caps (file-count primary, time ceiling backstop) keep full-repo scans
 * predictable; hitting a cap degrades gracefully (partial evidence, capHit flag).
 */
import path from 'node:path';
import { listFilesRel } from './util.mjs';
import { runDetector } from './detectors.mjs';

export const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.apex',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
];

const DEFAULT_CAP_FILES = 4000;
const DEFAULT_CAP_MS = 45000;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mov|exe|dll|node)$/i;

/** Convert a simple glob (supports **, *, {a,b}) to a RegExp anchored full-match. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, close).split(',').map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
      re += '(' + alts.join('|') + ')';
      i = close;
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesAny(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel));
}

/**
 * Gather the bounded file list for a recipe.
 * Returns { files, capHit }.
 */
export function gatherFiles(repoRoot, recipe) {
  const ignore = [...DEFAULT_IGNORE, ...(recipe.ignore ?? [])];
  const all = listFilesRel(repoRoot, { ignore }).filter((f) => !BINARY_EXT.test(f));
  const capFiles = recipe.capFiles ?? DEFAULT_CAP_FILES;

  let candidate;
  if (recipe.scanScope === 'targeted') {
    const globs = recipe.targetedGlobs ?? [];
    candidate = all.filter((f) => matchesAny(f, globs));
  } else {
    candidate = all;
  }

  const capHit = candidate.length > capFiles;
  return { files: capHit ? candidate.slice(0, capFiles) : candidate, capHit };
}

/**
 * Run Stage A for one skill. `now` is injectable for deterministic tests.
 */
export function collectEvidence(repoRoot, recipe, { now = () => Date.now() } = {}) {
  const start = now();
  const capMs = recipe.capMs ?? DEFAULT_CAP_MS;
  const { files, capHit: fileCapHit } = gatherFiles(repoRoot, recipe);

  const ctx = { repoRoot, files };
  const entries = [];
  let timeCapHit = false;

  for (const detector of recipe.detectors ?? []) {
    if (now() - start > capMs) {
      timeCapHit = true;
      break;
    }
    entries.push(...runDetector(detector, ctx));
  }

  return {
    entries,
    meta: {
      skill: recipe.skill,
      scanScope: recipe.scanScope,
      filesScanned: files.length,
      capHit: fileCapHit || timeCapHit,
      detectorsRun: (recipe.detectors ?? []).length,
    },
  };
}

/** Index evidence by detector then key for slot lookup. */
export function indexEvidence(entries) {
  const idx = {};
  for (const e of entries) {
    (idx[e.detector] ??= {})[e.key] = e;
  }
  return idx;
}
