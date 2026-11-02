import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CREDENTIAL = /AKIA[0-9A-Z]{16}|-----BEGIN |ghp_[A-Za-z0-9]{20,}|xoxb-/;

function walk(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') {
      continue;
    }
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full, found);
      continue;
    }
    if (/\.(ts|tsx|mjs|json|md)$/.test(name)) {
      found.push(full);
    }
  }
}

/**
 * Checks fixture files this feature owns. Emails must end in @example.test.
 * displayName, subject, and externalSubject strings must start with test-.
 */
export function scanSyntheticData(roots) {
  const problems = [];
  const files = [];
  for (const root of roots) {
    walk(root, files);
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(EMAIL)) {
      if (!match[0].endsWith('@example.test')) {
        problems.push(`${file}: email ${match[0]} must end with @example.test`);
      }
    }
    if (CREDENTIAL.test(text)) {
      problems.push(`${file}: value looks like a real credential`);
    }
    const named =
      /(?:displayName|subject|externalSubject)\s*[:=]\s*['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(named)) {
      if (!match[1].startsWith('test-')) {
        problems.push(`${file}: ${match[1]} must start with the test- prefix`);
      }
    }
  }
  return problems;
}
