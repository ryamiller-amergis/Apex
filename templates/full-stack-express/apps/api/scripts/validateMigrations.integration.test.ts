import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const EMAIL_LINE = "    email: varchar('email', { length: 254 }),\n";
const PHONE_LINE = "    phone: varchar('phone_number', { length: 32 }),\n";

const copies: string[] = [];

function copyApi(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'api-copy-'));
  copies.push(root);
  mkdirSync(path.join(root, 'src', 'persistence'), { recursive: true });
  cpSync(
    path.join(apiRoot, 'src', 'persistence', 'schema.ts'),
    path.join(root, 'src', 'persistence', 'schema.ts')
  );
  cpSync(path.join(apiRoot, 'drizzle'), path.join(root, 'drizzle'), {
    recursive: true,
  });
  symlinkSync(
    path.join(apiRoot, 'node_modules'),
    path.join(root, 'node_modules'),
    'junction'
  );
  return root;
}

function addPhoneColumn(root: string): void {
  const file = path.join(root, 'src', 'persistence', 'schema.ts');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain(EMAIL_LINE);
  writeFileSync(file, text.replace(EMAIL_LINE, `${EMAIL_LINE}${PHONE_LINE}`));
}

function runScript(script: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(apiRoot, 'scripts', script), ...args],
    { cwd: apiRoot, encoding: 'utf8', windowsHide: true }
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function sqlFiles(root: string): string[] {
  return readdirSync(path.join(root, 'drizzle'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

afterEach(() => {
  for (const root of copies.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('migrate:validate', () => {
  it('TBI-007 DoD-3 the committed migrations match the Drizzle schema', () => {
    const result = runScript('validateMigrations.ts', []);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('Migrations match the Drizzle schema.');
  }, 30000);

  it('VT-15 PBI-003 AC-0 a generated migration for a new column passes validation', () => {
    const root = copyApi();
    addPhoneColumn(root);

    const generated = runScript('generateMigration.ts', [
      '--root',
      root,
      '--',
      '--name',
      'add_phone',
    ]);
    expect(generated.status, generated.output).toBe(0);
    expect(sqlFiles(root)).toEqual([
      '0000_init_app_users.sql',
      '0001_add_phone.sql',
    ]);
    const sql = readFileSync(
      path.join(root, 'drizzle', '0001_add_phone.sql'),
      'utf8'
    );
    expect(sql).toContain('ADD COLUMN "phone_number" varchar(32)');

    const validated = runScript('validateMigrations.ts', ['--root', root]);
    expect(validated.status, validated.output).toBe(0);
    expect(validated.output).toContain('Migrations match the Drizzle schema.');
  }, 60000);

  it('VT-16 PBI-003 AC-1 a schema change with no migration fails and names the difference', () => {
    const root = copyApi();
    addPhoneColumn(root);

    const result = runScript('validateMigrations.ts', ['--root', root]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'Schema differs from committed migrations. Run "pnpm db:generate" and commit the result.'
    );
    expect(result.output).toContain('"phone_number"');
    expect(sqlFiles(root)).toEqual(['0000_init_app_users.sql']);
  }, 60000);

  it('fails when the journal names a migration file that is missing', () => {
    const root = copyApi();
    rmSync(path.join(root, 'drizzle', 'meta', '0000_snapshot.json'));

    const result = runScript('validateMigrations.ts', ['--root', root]);
    expect(result.status).toBe(1);
    expect(result.output).not.toContain('Migrations match the Drizzle schema.');
  }, 60000);
});
