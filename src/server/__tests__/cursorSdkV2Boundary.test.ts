/**
 * TBI-002 DoD-0 / DoD-3 / VT-17:
 * Single-import boundary test across the four V2 host directories and the two
 * shared type-only importers (`nativeReadToolAdapter.ts`, `interviewGroundingPolicy.ts`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SERVICES_ROOT = resolve(__dirname, '../services');

const V2_HOST_DIRS = [
  resolve(SERVICES_ROOT, 'interactiveActorHost'),
  resolve(SERVICES_ROOT, 'aiRunsWorker'),
  resolve(SERVICES_ROOT, 'aiRunsV2Worker'),
  resolve(SERVICES_ROOT, 'aiRunV2'),
];

const REROUTED_TYPE_IMPORTERS = [
  resolve(SERVICES_ROOT, 'nativeReadToolAdapter.ts'),
  resolve(SERVICES_ROOT, 'interviewGroundingPolicy.ts'),
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SDK_IMPORT_RE =
  /(?:from\s+['"]@cursor\/sdk(?:\/[^'"]*)?['"]|import\s*\(\s*['"]@cursor\/sdk(?:\/[^'"]*)?['"]\s*\)|require\s*\(\s*['"]@cursor\/sdk(?:\/[^'"]*)?['"]\s*\))/;

describe('Cursor SDK V2 single-import boundary (TBI-002 DoD-0 / DoD-3 / VT-17)', () => {
  const hostFiles = V2_HOST_DIRS.flatMap(collectTsFiles);

  it('DoD-0 / VT-17: zero files in V2 host folders import @cursor/sdk directly (value or type)', () => {
    expect(hostFiles.length).toBeGreaterThan(10);
    const violations = hostFiles.filter((file) =>
      SDK_IMPORT_RE.test(readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('DoD-0 / VT-17: nativeReadToolAdapter and interviewGroundingPolicy import SDK types from cursorSdkAdapter/types', () => {
    for (const file of REROUTED_TYPE_IMPORTERS) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(SDK_IMPORT_RE);
      expect(source).toMatch(/cursorSdkAdapter\/types/);
    }
  });

  it('DoD-3 / VT-17: interactive actor host and AI run worker both acquire agents through cursorSdkAdapter', () => {
    const actorSource = readFileSync(
      resolve(SERVICES_ROOT, 'interactiveActorHost/interactiveCursorExecution.ts'),
      'utf8',
    );
    const workerSource = readFileSync(
      resolve(SERVICES_ROOT, 'aiRunsWorker/cursorExecution.ts'),
      'utf8',
    );
    expect(actorSource).toMatch(/cursorSdkAdapter/);
    expect(actorSource).not.toMatch(/export\s+async\s+function\s+createInteractiveCursorExecution/);
    expect(workerSource).toMatch(/cursorSdkAdapter/);
  });
});
