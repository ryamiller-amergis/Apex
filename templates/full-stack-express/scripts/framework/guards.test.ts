import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanCoverageArtifacts } from '../scan-coverage-artifacts.mjs';
import { scanCoverageThresholds } from '../scan-coverage-thresholds.mjs';
import { scanSyntheticData } from '../scan-synthetic-data.mjs';
import { runNode, templateRootDir } from './runFixture.ts';

describe('shared floors (TBI-023 NFR)', () => {
  it('VT-13 TBI-023 NFR no vitest config other than the root sets thresholds', () => {
    const problems = scanCoverageThresholds(templateRootDir);
    expect(problems).toEqual([]);
  });

  it('VT-13 a planted thresholds key in a package config is named', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-threshold-'));
    const planted = path.join(dir, 'packages', 'sample');
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      path.join(planted, 'vitest.config.ts'),
      'export default { test: { coverage: { thresholds: { lines: 1 } } } };\n'
    );
    try {
      const problems = scanCoverageThresholds(dir);
      expect(problems.join('\n')).toMatch(/thresholds/);
      expect(problems.join('\n')).toMatch(/shared floors/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('synthetic fixtures (VT-31)', () => {
  it('VT-31 fixture files use @example.test and the test- prefix', () => {
    const problems = scanSyntheticData([
      path.join(templateRootDir, 'apps', 'api', 'test', 'fixtures'),
      path.join(templateRootDir, 'e2e'),
    ]);
    expect(problems).toEqual([]);
  });

  it('VT-31 a real-looking email in a fixture file is named', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-synthetic-'));
    writeFileSync(
      path.join(dir, 'bad.ts'),
      "export const subject = 'ada@example.com';\nexport const displayName = 'Ada Lovelace';\n"
    );
    try {
      const problems = scanSyntheticData([dir]);
      expect(problems.join('\n')).toMatch(/example\.com/);
      expect(problems.join('\n')).toMatch(/Ada Lovelace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('coverage artifacts (PBI-023 NFR)', () => {
  it('VT-14 a coverage file that repeats a fixture identity fails the scan', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-artifact-'));
    writeFileSync(
      path.join(dir, 'coverage-summary.json'),
      JSON.stringify({ note: 'test-subject-a person.a@example.test' })
    );
    try {
      const problems = scanCoverageArtifacts(dir);
      expect(problems.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VT-14 an empty totals file passes the scan', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-artifact-ok-'));
    writeFileSync(
      path.join(dir, 'coverage-summary.json'),
      JSON.stringify({ total: { lines: { pct: 80 } } })
    );
    try {
      expect(scanCoverageArtifacts(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Docker guard (PBI-022 AC-2)', () => {
  it('VT-07 PBI-022 AC-2 a dead DOCKER_HOST prints the Docker message for integration and e2e', async () => {
    const script = path.join(templateRootDir, 'scripts', 'docker-guard.mjs');
    for (const suite of ['integration', 'e2e'] as const) {
      const result = await runNode([script, suite], {
        env: {
          ...process.env,
          DOCKER_HOST: 'unix:///tmp/feat-011-no-docker.sock',
        },
        timeoutMs: 20_000,
      });
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        `Docker is required to run the ${suite} tests.`
      );
      expect(result.output).toContain(`pnpm test:${suite}`);
      expect(result.output).not.toMatch(/ECONNREFUSED/);
      expect(result.output).not.toMatch(/password authentication/i);
      expect(result.output).not.toMatch(/pg-pool/);
    }
  }, 40_000);
});

describe('removed authentication (PBI-022 AC-3)', () => {
  it('VT-08 PBI-022 AC-3 API tests fail when the auth middleware always lets the request through', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-auth-'));
    mkdirSync(dir, { recursive: true });
    const passThrough = path.join(dir, 'pass-through-auth.ts');
    writeFileSync(
      passThrough,
      `import type { RequestHandler } from 'express';
export class PrincipalMissingError extends Error {}
export const AUTHENTICATION_REQUIRED_DETAIL = 'Authentication is required.';
export const DEFAULT_CHALLENGE = 'Bearer';
export function getPrincipal(): { subject: string } {
  return { subject: 'test-subject-open' };
}
export function createAuthMiddleware(): RequestHandler {
  return (_req, res, next) => {
    res.locals.principal = { subject: 'test-subject-open', displayName: 'test-name-open' };
    next();
  };
}
`
    );
    const replacement = JSON.stringify(passThrough);
    const configPath = path.join(dir, 'vitest.config.ts');
    writeFileSync(
      configPath,
      `export default {
  resolve: {
    alias: [{ find: /^.*authMiddleware\\.ts$/, replacement: ${replacement} }],
  },
  test: {
    include: ['apps/api/test/api/**/*.api.test.ts'],
    name: 'api',
  },
};
`
    );
    try {
      const result = await runNode(
        [
          path.join(templateRootDir, 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          '--config',
          configPath,
        ],
        { cwd: templateRootDir, timeoutMs: 90_000 }
      );
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/unauthenticated/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('selector convention (TBI-025 DoD-2)', () => {
  it('VT-27 TBI-025 DoD-2 a CSS locator in e2e fails lint and names the file', async () => {
    const file = path.join(
      templateRootDir,
      'e2e',
      'specs',
      'planted-brittle.spec.ts'
    );
    writeFileSync(
      file,
      `import { test } from '@playwright/test';
test('planted', async ({ page }) => {
  await page.locator('.secret').click();
});
`
    );
    try {
      const result = await runNode(
        [
          path.join(
            templateRootDir,
            'node_modules',
            'eslint',
            'bin',
            'eslint.js'
          ),
          file,
        ],
        { cwd: templateRootDir }
      );
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain('planted-brittle.spec.ts');
      expect(result.output).toMatch(/brittle|locator/i);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
