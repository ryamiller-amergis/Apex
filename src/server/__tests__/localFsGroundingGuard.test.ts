/**
 * TBI-005 / VT-33 — Guard test verifying that the `local.fs` spike
 * produced a written recommendation and left zero `local.fs` references
 * in production source under `src/`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const SPIKE_DOC = resolve(REPO_ROOT, 'design-docs', 'local-fs-grounding-spike.md');

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('TBI-005 local.fs grounding spike guard (VT-33)', () => {
  it('DoD-0 / DoD-1 / VT-33: records startup gain, capabilities lost, and an explicit recommendation', () => {
    expect(existsSync(SPIKE_DOC)).toBe(true);
    const content = readFileSync(SPIKE_DOC, 'utf8');
    expect(content).toMatch(/Startup gain/i);
    expect(content).toMatch(/Capabilities lost/i);
    expect(content).toMatch(/Recommendation:\s*(Defer|Drop|Adopt)/i);
  });

  it('DoD-2 / VT-33: production code under src/ has zero references to local.fs grounding', () => {
    const prodFiles = collectTsFiles(SRC_ROOT);
    expect(prodFiles.length).toBeGreaterThan(20);

    const offenders = prodFiles.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return (
        /\blocal\s*\.\s*fs\b/.test(source)
        || /\b(?:overlayFs|childOverlayFs|emptyFs|tempFs|unionFs|readOnlyFs|createFileSystemTools)\b/.test(source)
      );
    });

    expect(offenders).toEqual([]);
  });
});
