import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templateRoot = path.resolve(import.meta.dirname, '../..');
const runbook = readFileSync(
  path.join(templateRoot, 'docs/runbooks/migrations.md'),
  'utf8'
);
const prose = runbook.replace(/\s+/g, ' ');
const headings = runbook
  .split(/\r?\n/)
  .filter((line) => line.startsWith('## '))
  .map((line) => line.slice(3).trim());

describe('migration runbook', () => {
  it('VT-19 TBI-007 DoD-4 has sections for ownership, workflow, running, and rollback', () => {
    for (const heading of [
      'Ownership',
      'Workflow',
      'Running the migration command',
      'Rollback',
    ]) {
      expect(headings).toContain(heading);
    }
  });

  it('VT-19 TBI-007 DoD-4 BR-006 states the ownership split and forward-only rollback', () => {
    expect(prose).toContain(
      'The application repository owns the migration files.'
    );
    expect(prose).toContain(
      'Platform Engineering owns running them in every shared environment.'
    );
    expect(prose).toContain(
      'Production rollback is forward-only: ship a new corrective migration.'
    );
    expect(prose).toContain('The application never changes the schema');
  });

  it('documents the commands and the migrate exit codes', () => {
    for (const text of [
      'pnpm db:generate -- --name',
      'pnpm migrate:validate',
      'pnpm migrate',
      'pnpm seed',
      'node dist/cli/migrate.js',
      '| 0 ',
      '| 1 ',
      '| 2 ',
    ]) {
      expect(prose).toContain(text);
    }
  });
});
