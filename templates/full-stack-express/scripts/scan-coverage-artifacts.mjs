import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const MARKERS = [
  /@example\.test/i,
  /test-subject-/,
  /test-name-/,
  /synthetic-subject/,
  /password/i,
  /postgres:\/\//i,
];

function filesUnder(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      found.push(...filesUnder(full));
      continue;
    }
    if (/\.(json|txt|lcov|info)$/.test(name) || name === 'lcov.info') {
      found.push(full);
    }
  }
  return found;
}

/** Coverage reports may contain paths and percentages, never fixture identity. */
export function scanCoverageArtifacts(dir) {
  const problems = [];
  for (const file of filesUnder(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const marker of MARKERS) {
      if (marker.test(text)) {
        problems.push(`${path.basename(file)} matches ${marker}`);
      }
    }
  }
  return problems;
}
