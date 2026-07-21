#!/usr/bin/env node
/**
 * Repo-level validation entry point for the foundation-skills package.
 * Wraps the package validator so CI and local runs share one implementation.
 *
 *   node scripts/validate-foundation-skills.mjs
 */
import path from 'node:path';
import url from 'node:url';
import { validatePackage } from '../foundation-skills/lib/validatePackage.mjs';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const pkgRoot = path.join(repoRoot, 'foundation-skills');

const result = validatePackage(pkgRoot);
for (const w of result.warnings) console.warn(`WARN  ${w}`);
for (const e of result.errors) console.error(`ERROR ${e}`);

if (result.ok) {
  console.log(`foundation-skills package valid (${result.warnings.length} warnings).`);
  process.exit(0);
} else {
  console.error(`foundation-skills package INVALID (${result.errors.length} errors).`);
  process.exit(1);
}
