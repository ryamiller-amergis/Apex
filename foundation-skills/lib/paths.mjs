/**
 * Canonical path utilities for the @apex/skills installer.
 *
 * All paths are normalized to POSIX separators in the lockfile so the file is
 * identical across Windows (PowerShell/cmd/Git Bash) and POSIX shells.
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/** Absolute path to the root of the @apex/skills package (foundation-skills/) */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path to the catalog.json file */
export const CATALOG_PATH = join(PACKAGE_ROOT, 'catalog.json');

/** Absolute path to the foundation/ directory inside the package */
export const FOUNDATION_DIR = join(PACKAGE_ROOT, 'foundation');

/**
 * Standard install destination paths relative to the target repo root.
 * The repo root is the current working directory when `apex-skills install` runs.
 */
export const LOCK_FILENAME    = 'apex-skills.lock.json';
export const FOUNDATION_DEST  = '.apex/foundation';  // immutable vendored foundations
export const ADAPTER_DEST     = '.cursor/skills';     // editable project adapters

/**
 * Convert an OS path to a POSIX string (for lockfile storage).
 * On POSIX this is a no-op; on Windows it replaces backslashes.
 */
export function toPosix(p) {
  return p.split(sep).join(posix.sep);
}

/**
 * Resolve a path relative to the target repo root (process.cwd() at install time).
 */
export function repoPath(...parts) {
  return resolve(process.cwd(), ...parts);
}

/**
 * Return the POSIX-normalized path of `abs` relative to `base`.
 * Used when recording paths in the lockfile.
 */
export function relPosix(abs, base) {
  return toPosix(relative(base, abs));
}
