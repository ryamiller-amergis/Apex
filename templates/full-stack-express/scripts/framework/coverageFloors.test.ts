import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runCoverageFixture,
  runCoverageSource,
  runNode,
  templateRootDir,
  vitestBin,
} from './runFixture.ts';

describe('coverage floors (PBI-023)', () => {
  it('VT-09 PBI-023 AC-0 passes and prints the totals when every floor is met', async () => {
    const result = await runCoverageFixture({
      both: 4,
      oneSided: 0,
      straight: 4,
      unused: 0,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Branch/i);
    expect(result.summary.lines?.pct).toBeGreaterThanOrEqual(80);
    expect(result.summary.branches?.pct).toBeGreaterThanOrEqual(75);
  }, 90_000);

  it('VT-10 PBI-023 AC-1 fails and names branches when branch coverage is 74%', async () => {
    const result = await runCoverageFixture({
      both: 12,
      oneSided: 13,
      straight: 40,
      unused: 0,
    });
    expect(result.summary.branches?.pct, JSON.stringify(result.summary)).toBe(
      74
    );
    expect(result.summary.lines?.pct).toBeGreaterThan(80);
    expect(result.summary.functions?.pct).toBeGreaterThan(80);
    expect(result.summary.statements?.pct).toBeGreaterThan(80);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/branches/i);
    expect(result.output).toContain('75');
  }, 90_000);

  it('VT-11 PBI-023 AC-2 passes when branches are exactly 75% and the other metrics are exactly 80%', async () => {
    const result = await runCoverageSource(
      `export function b(flag: boolean, other: boolean): number {
  if (flag) return 1;
  if (other) return 2;
  return 0;
}
export function s0(): number {
  const value = 0; const extra = 1;
  return value + extra;
}
export function s1(): number {
  const value = 1; const extra = 1;
  return value + extra;
}
export function s2(): number {
  const value = 2;
  return value;
}
export function u0(): number {
  const hidden = 1; return hidden;
}
`,
      `import { expect, it } from "vitest";
import { b, s0, s1, s2 } from "./subject.ts";
it("covers the exact floors", () => {
  expect(b(true, false)).toBe(1);
  expect(b(false, true)).toBe(2);
  expect(s0()).toBe(1);
  expect(s1()).toBe(2);
  expect(s2()).toBe(2);
});
`
    );
    expect(
      {
        lines: result.summary.lines?.pct,
        functions: result.summary.functions?.pct,
        statements: result.summary.statements?.pct,
        branches: result.summary.branches?.pct,
      },
      `${JSON.stringify(result.summary)}\n${result.output}`
    ).toEqual({
      lines: 80,
      functions: 80,
      statements: 80,
      branches: 75,
    });
    expect(result.status, result.output).toBe(0);
  }, 90_000);
});

describe('failure output (PBI-022 AC-1)', () => {
  it('VT-06 PBI-022 AC-1 Vitest names the test, the expected value, and the received value', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-fail-'));
    writeFileSync(
      path.join(dir, 'mismatch.test.ts'),
      `import { expect, it } from 'vitest';
it('VT-06 the values differ', () => {
  expect(1).toBe(2);
});
`
    );
    writeFileSync(
      path.join(dir, 'vitest.config.ts'),
      `export default { root: ${JSON.stringify(dir)}, test: { include: ['mismatch.test.ts'] } };
`
    );
    try {
      const result = await runNode(
        [vitestBin, 'run', '--config', path.join(dir, 'vitest.config.ts')],
        { cwd: templateRootDir }
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('VT-06 the values differ');
      expect(result.output).toMatch(/expected/i);
      expect(result.output).toContain('1');
      expect(result.output).toContain('2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('VT-06 PBI-022 AC-1 Playwright names the test, the expected value, and the received value', async () => {
    const dir = path.join(templateRootDir, '.test-fixtures', 'pw-mismatch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'mismatch.spec.ts'),
      `import { expect, test } from '@playwright/test';
test('VT-06 the values differ', () => {
  expect(1).toBe(2);
});
`
    );
    writeFileSync(
      path.join(dir, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: ${JSON.stringify(dir)},
  retries: 0,
  workers: 1,
  reporter: 'list',
  projects: [{ name: 'chromium' }],
});
`
    );
    const cli = path.join(
      templateRootDir,
      'node_modules',
      '@playwright',
      'test',
      'cli.js'
    );
    try {
      const result = await runNode(
        ['--', cli, 'test', '--config', path.join(dir, 'playwright.config.ts')],
        {
          cwd: dir,
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('VT-06 the values differ');
      expect(result.output).toMatch(/Expected/);
      expect(result.output).toMatch(/Received/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
