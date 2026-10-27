import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const templateRoot = path.resolve(import.meta.dirname, '../..');

function readExample(text) {
  const entries = new Map();
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      throw new Error(`Unparsed environment line: ${trimmed}`);
    }
    const key = trimmed.slice(0, eq).trim();
    if (seen.has(key)) {
      throw new Error(`Variable listed more than once: ${key}`);
    }
    seen.add(key);
    entries.set(key, trimmed.slice(eq + 1));
  }
  return entries;
}

const exampleText = readFileSync(
  path.join(templateRoot, '.env.example'),
  'utf8'
);
const example = readExample(exampleText);
const composeText = readFileSync(
  path.join(templateRoot, 'compose.yaml'),
  'utf8'
);
const compose = parse(composeText);
const rootManifest = JSON.parse(
  readFileSync(path.join(templateRoot, 'package.json'), 'utf8')
);
const readme = readFileSync(path.join(templateRoot, 'README.md'), 'utf8');

const docker = spawnSync('docker', ['compose', 'version'], {
  encoding: 'utf8',
  windowsHide: true,
});
const dockerAvailable = docker.status === 0;

describe('example file secrets', () => {
  it('VT-12 PBI-002 AC-3 TBI-004 DoD-1 keeps the example file synthetic', () => {
    expect(exampleText).not.toMatch(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/);
    expect(exampleText).not.toMatch(
      /\b(?:ghp_|github_pat_|gho_|glpat-|sk-|xox[baprs]-|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{10,})\b/
    );
    for (const [key, value] of example) {
      if (/PASSWORD|SECRET|TOKEN|KEY/i.test(key)) {
        expect(value.startsWith('local-dev-only'), key).toBe(true);
      }
    }
  });
});

describe('compose settings', () => {
  it('VT-13 TBI-005 DoD-2 matches the example database settings', () => {
    const names = new Set();
    for (const match of composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.add(match[1]);
    }
    for (const name of names) {
      expect(example.has(name), name).toBe(true);
    }

    const databaseUrl = new URL(example.get('DATABASE_URL'));
    expect(databaseUrl.username).toBe(example.get('POSTGRES_USER'));
    expect(databaseUrl.password).toBe(example.get('POSTGRES_PASSWORD'));
    expect(databaseUrl.port).toBe(example.get('POSTGRES_PORT'));
    expect(databaseUrl.pathname.slice(1)).toBe(example.get('POSTGRES_DB'));

    const ports = compose.services.postgres.ports.map(String).join(' ');
    expect(ports).toContain('127.0.0.1');
    expect(compose.services.postgres.image).toBe('postgres:16');
  });

  it.skipIf(!dockerAvailable)(
    'VT-14 TBI-005 DoD-0 docker compose config accepts the example file (skipped when the docker CLI is absent)',
    () => {
      const result = spawnSync(
        'docker',
        ['compose', '--env-file', '.env.example', 'config', '--quiet'],
        { cwd: templateRoot, encoding: 'utf8', windowsHide: true }
      );
      expect(result.status, result.stderr).toBe(0);
    }
  );
});

describe('script surface', () => {
  const required = [
    'setup',
    'build',
    'check',
    'test',
    'dev',
    'migrate',
    'seed',
    'db:up',
    'db:down',
  ];

  it('VT-15 TBI-005 DoD-1 DoD-3 lists every script and documents its purpose', () => {
    expect(rootManifest.scripts.install).toBeUndefined();
    for (const name of required) {
      expect(rootManifest.scripts[name], name).toEqual(expect.any(String));
      expect(readme).toContain(`\`${name}\``);
    }
    expect(rootManifest.scripts.setup).toContain('--frozen-lockfile');
    expect(rootManifest.scripts.check).toContain('typecheck');
    expect(rootManifest.scripts.check).toContain('lint');
    expect(rootManifest.scripts.check).toContain('format:check');
    expect(rootManifest.scripts.dev).toContain('--parallel');
    expect(rootManifest.scripts.migrate).toContain('db:migrate');
    expect(rootManifest.scripts.seed).toContain('db:seed');
    expect(rootManifest.scripts['db:up']).toContain('docker compose up');
    expect(rootManifest.scripts['db:down']).toContain('docker compose down');
    expect(readme).toContain('## Change the PostgreSQL port');
    expect(readme).toContain('POSTGRES_PORT');
    expect(readme).toContain('DATABASE_URL');
  });

  it('TBI-007 migrate, seed, db:generate, and migrate:validate run the API persistence commands', () => {
    const apiManifest = JSON.parse(
      readFileSync(path.join(templateRoot, 'apps/api/package.json'), 'utf8')
    );
    for (const [root, api, entry] of [
      ['migrate', 'db:migrate', 'src/cli/migrate.ts'],
      ['seed', 'db:seed', 'src/cli/seed.ts'],
      ['db:generate', 'db:generate', 'scripts/generateMigration.ts'],
      ['migrate:validate', 'migrate:validate', 'scripts/validateMigrations.ts'],
    ]) {
      expect(rootManifest.scripts[root], root).toContain(`run ${api}`);
      expect(apiManifest.scripts[api], api).toContain(entry);
      expect(readme).toContain(`\`${root}\``);
    }
    expect(readme).not.toContain('Provided by the Starter Persistence feature');
    expect(readme).toContain('docs/runbooks/migrations.md');
  });
});
