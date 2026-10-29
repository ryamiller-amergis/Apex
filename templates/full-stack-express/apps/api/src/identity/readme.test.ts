import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const readmePath = path.join(here, 'README.md');
const templateReadmePath = path.resolve(here, '../../../../README.md');

function readme(): string {
  expect(existsSync(readmePath), 'apps/api/src/identity/README.md').toBe(true);
  return readFileSync(readmePath, 'utf8');
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  expect(start, `missing "## ${heading}"`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next === -1 ? undefined : next);
}

describe('identity README (VT-13)', () => {
  it('TBI-012 DoD-0 documents the principal contract and adapter interface', () => {
    const contract = section(readme(), 'Contract');
    for (const term of [
      'Principal',
      'subject',
      'displayName',
      'email',
      'IdentityProviderAdapter',
      'authenticate',
      'null',
      'createAuthMiddleware',
      'getPrincipal',
      '401',
      'application/problem+json',
      'WWW-Authenticate',
    ]) {
      expect(contract, term).toContain(term);
    }
  });

  it('PBI-009 AC-0 explains how to write and register a provider adapter', () => {
    const steps = section(readme(), 'Add a production identity provider');
    for (const term of ['registry.ts', 'AUTH_MODE=external', 'verify']) {
      expect(steps, term).toContain(term);
    }
  });

  it('PBI-009 AC-3 states that roles are not defined and where RBAC attaches', () => {
    const rbac = section(readme(), 'Roles and RBAC');
    expect(rbac).toContain('The template defines no roles or permissions');
    expect(rbac).toContain('authenticate');
    expect(rbac).toContain('app.ts');
  });

  it('states the logging rule and the production environment rule', () => {
    const text = readme();
    expect(section(text, 'Logging')).toContain('never');
    expect(section(text, 'Development adapter')).toContain(
      'NODE_ENV=production'
    );
  });

  it('is linked from the template README', () => {
    expect(readFileSync(templateReadmePath, 'utf8')).toContain(
      'apps/api/src/identity/README.md'
    );
  });
});
