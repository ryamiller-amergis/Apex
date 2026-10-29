import { readFileSync } from 'node:fs';
import path from 'node:path';
import { templateRoot } from './constants.mjs';

export const secretIgnoreFile = path.join(
  templateRoot,
  'config',
  'supply-chain',
  'secret-scan.ignore'
);

export function loadIgnorePatterns(file = secretIgnoreFile) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export function matchesIgnore(relativePath, pattern) {
  const file = relativePath.split('\\').join('/');
  const normalized = pattern.split('\\').join('/');
  if (normalized.startsWith('**/')) {
    const rest = normalized.slice(3);
    if (rest.endsWith('/**')) {
      const segment = rest.slice(0, -3);
      return file.split('/').includes(segment);
    }
    if (rest.startsWith('*.')) {
      return file.endsWith(rest.slice(1));
    }
  }
  return file === normalized || file.endsWith(`/${normalized}`);
}

export function isSecretScanIgnored(relativePath, patterns) {
  return patterns.some((pattern) => matchesIgnore(relativePath, pattern));
}
