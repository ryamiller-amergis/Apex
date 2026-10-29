import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const readme = readFileSync(path.join(packageRoot, 'README.md'), 'utf8');

function section(heading: string): string {
  const start = readme.indexOf(`## ${heading}`);
  expect(start, `missing "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf('\n## ', start + 3);
  return readme.slice(start, next === -1 ? undefined : next);
}

describe('contracts README (TBI-011 DoD-3)', () => {
  it('TBI-011 DoD-3 lists the conventions for a new endpoint', () => {
    const conventions = section('Conventions for new endpoints');
    for (const rule of [
      'defineRoute',
      '/api/v',
      'Problem Details',
      'application/problem+json',
      'X-Request-Id',
      'limit',
      'cursor',
      'z.strictObject',
      'userId',
      'pnpm openapi:generate',
      'pnpm openapi:check',
    ]) {
      expect(conventions, rule).toContain(rule);
    }
  });

  it('TBI-011 DoD-3 states the numeric limits that the code enforces', () => {
    const conventions = section('Conventions for new endpoints');
    expect(conventions).toContain('default 20');
    expect(conventions).toContain('maximum 100');
    expect(conventions).toContain('512');
    expect(conventions).toContain('128');
  });

  it('documents how each consumer imports the contracts', () => {
    const consuming = section('Consuming the contracts');
    for (const entry of [
      '@project-scope/contracts',
      '@project-scope/contracts/openapi',
      '@project-scope/contracts/openapi.json',
      'compareRouteInventory',
      'InferBody',
      'InferResponse',
    ]) {
      expect(consuming, entry).toContain(entry);
    }
  });
});
