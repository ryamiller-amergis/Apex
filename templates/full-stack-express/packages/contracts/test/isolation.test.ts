import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const forbidden = ['express', 'react', 'react-dom', 'drizzle-orm', 'pg'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

function importSpecifiers(text: string): string[] {
  const pattern =
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  return [...text.matchAll(pattern)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? ''
  );
}

describe('package isolation (VT-12)', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ) as Record<string, Record<string, string> | string | boolean>;

  it('TBI-009 DoD-3 has zod as its only runtime dependency', () => {
    expect(Object.keys(manifest.dependencies as object)).toEqual(['zod']);
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('TBI-009 DoD-3 declares no framework or database package anywhere', () => {
    for (const field of ['dependencies', 'devDependencies']) {
      const names = Object.keys((manifest[field] as object | undefined) ?? {});
      for (const name of forbidden) {
        expect(names).not.toContain(name);
      }
    }
  });

  it('TBI-009 DoD-3 is ESM-only and side-effect free', () => {
    expect(manifest.type).toBe('module');
    expect(manifest.sideEffects).toBe(false);
    expect(Object.keys(manifest.exports as object)).toEqual([
      '.',
      './openapi',
      './openapi.json',
    ]);
  });

  it('TBI-009 DoD-3 src imports only zod and relative files, never node: modules', () => {
    const files = sourceFiles(path.join(packageRoot, 'src'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const allowed =
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier === 'zod';
        expect(
          allowed,
          `${path.relative(packageRoot, file)} imports ${specifier}`
        ).toBe(true);
      }
    }
  });
});
