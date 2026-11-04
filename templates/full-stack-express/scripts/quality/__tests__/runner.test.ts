import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateTargets,
  measurementsFromSummary,
  resolveTarget,
} from '../lib/load-test.mjs';
import { runNode, runnerScript, templateRoot, validNfr } from './fixture.ts';

const TIMEOUT = 30_000;

type Manifest = Parameters<typeof evaluateTargets>[0];

function manifest(): Manifest {
  return validNfr() as unknown as Manifest;
}

function verdicts(
  result: ReturnType<typeof evaluateTargets>
): Record<string, string> {
  return Object.fromEntries(
    result.results.map((entry) => [entry.target, entry.verdict])
  );
}

function runnerEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('LOAD_TEST_')) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}

describe('evaluateTargets', () => {
  it('VT-18 PBI-026 AC-0: met targets pass, and a slow percentile fails only responseTime', () => {
    const met = evaluateTargets(manifest(), {
      percentileMs: 480,
      vusMax: 50,
      failedRequests: 0,
      rows: 100_001,
    });
    expect(verdicts(met)).toEqual({
      responseTime: 'PASS',
      concurrency: 'PASS',
      dataVolume: 'PASS',
    });
    expect(met.pass).toBe(true);

    const slow = evaluateTargets(manifest(), {
      percentileMs: 501,
      vusMax: 50,
      failedRequests: 0,
      rows: 100_001,
    });
    expect(verdicts(slow)).toEqual({
      responseTime: 'FAIL',
      concurrency: 'PASS',
      dataVolume: 'PASS',
    });
    expect(slow.pass).toBe(false);
  });

  it('VT-18 PBI-026 AC-0: boundary values pass and a failed request fails concurrency', () => {
    const edge = evaluateTargets(manifest(), {
      percentileMs: 500,
      vusMax: 50,
      failedRequests: 0,
      rows: 100_000,
    });
    expect(edge.pass).toBe(true);
    const failing = evaluateTargets(manifest(), {
      percentileMs: 100,
      vusMax: 49,
      failedRequests: 0,
      rows: 99_999,
    });
    expect(verdicts(failing)).toEqual({
      responseTime: 'PASS',
      concurrency: 'FAIL',
      dataVolume: 'FAIL',
    });
    const errored = evaluateTargets(manifest(), {
      percentileMs: 100,
      vusMax: 50,
      failedRequests: 1,
      rows: 100_000,
    });
    expect(verdicts(errored).concurrency).toBe('FAIL');
  });

  it('VT-21 PBI-026 AC-0: no row count means NOT MEASURED and no overall pass', () => {
    const result = evaluateTargets(manifest(), {
      percentileMs: 480,
      vusMax: 50,
      failedRequests: 0,
    });
    expect(verdicts(result).dataVolume).toBe('NOT MEASURED');
    expect(result.pass).toBe(false);
  });

  it('PBI-026 AC-0: targets come from the manifest, not from the runner', () => {
    const custom = manifest();
    custom.targets.responseTime.maxMs = 200;
    const result = evaluateTargets(custom, {
      percentileMs: 480,
      vusMax: 50,
      failedRequests: 0,
      rows: 100_000,
    });
    expect(verdicts(result).responseTime).toBe('FAIL');
  });
});

describe('k6 summary and target parsing', () => {
  it('PBI-026 AC-0: reads the manifest percentile, peak users, and failed requests from a k6 summary', () => {
    const measured = measurementsFromSummary(
      {
        metrics: {
          http_req_duration: { values: { 'p(95)': 312.5, avg: 100 } },
          vus_max: { values: { value: 50, min: 50, max: 50 } },
          http_req_failed: { values: { rate: 0, passes: 0, fails: 1200 } },
        },
      },
      95
    );
    expect(measured).toEqual({
      percentileMs: 312.5,
      vusMax: 50,
      failedRequests: 0,
    });
    expect(measurementsFromSummary(undefined, 95)).toEqual({
      percentileMs: undefined,
      vusMax: undefined,
      failedRequests: undefined,
    });
  });

  it('PBI-026 NFR security: the printed target drops credentials and a local host maps to the Docker gateway', () => {
    const target = resolveTarget('http://user:secret@localhost:3000/');
    expect(target?.display).toBe('http://localhost:3000');
    expect(target?.container).toBe('http://host.docker.internal:3000');
    expect(target?.usesHostGateway).toBe(true);
    expect(resolveTarget('https://staging.example.test/base/')?.display).toBe(
      'https://staging.example.test/base'
    );
    expect(resolveTarget('ftp://example.test')).toBeUndefined();
    expect(resolveTarget('not a url')).toBeUndefined();
  });
});

describe('load-test runner CLI', () => {
  it(
    'VT-19 PBI-026 AC-0: exits non-zero before any request when LOAD_TEST_BASE_URL is unset',
    async () => {
      const result = await runNode([runnerScript], { env: runnerEnv({}) });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('LOAD_TEST_BASE_URL');
      expect(result.output).not.toContain('Target:');
    },
    TIMEOUT
  );

  it(
    'VT-20 PBI-024 NFR PBI-026 NFR: the auth header and database URL never reach the output',
    async () => {
      const sentinel = 'Bearer SENTINEL-7f3a9c';
      const dbSentinel = 'postgres://load:DBSENTINEL@127.0.0.1:1/none';
      const result = await runNode([runnerScript], {
        env: runnerEnv({
          LOAD_TEST_BASE_URL: 'http://127.0.0.1:9',
          LOAD_TEST_AUTH_HEADER: sentinel,
          LOAD_TEST_DATABASE_URL: dbSentinel,
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Target: http://127.0.0.1:9');
      expect(result.output).not.toContain('SENTINEL-7f3a9c');
      expect(result.output).not.toContain('DBSENTINEL');
    },
    TIMEOUT
  );
});

describe('sample load-test definition', () => {
  const source = readFileSync(
    path.join(templateRoot, 'quality/load-test/profile-read.k6.js'),
    'utf8'
  );

  it('TBI-028 DoD-1: reads its targets from the NFR manifest and holds no target numbers', () => {
    expect(source).toContain("open('../nfr-manifest.json')");
    expect(source).toMatch(/responseTime\.maxMs/);
    expect(source).toMatch(/responseTime\.percentile/);
    expect(source).toMatch(/concurrency\.users/);
    expect(source).not.toMatch(/\b(500|50|95|100000)\b/);
    expect(source).toContain('/api/v1/me');
  });

  it('PBI-026 NFR security: the target URL comes only from LOAD_TEST_BASE_URL', () => {
    expect(source).toContain('__ENV.LOAD_TEST_BASE_URL');
    expect(source).not.toMatch(/https?:\/\//);
  });
});
