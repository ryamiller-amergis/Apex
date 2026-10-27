import { ESLint } from 'eslint';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templateRoot = path.resolve(import.meta.dirname, '../..');
const apiSrc = path.join(templateRoot, 'apps/api/src');

const eslint = new ESLint({
  cwd: templateRoot,
  overrideConfigFile: path.join(templateRoot, 'eslint.config.mjs'),
});

const DRIVER_IMPORTS = [
  "import { eq } from 'drizzle-orm';",
  "import { pgTable } from 'drizzle-orm/pg-core';",
  "import pg from 'pg';",
  "import { defineConfig } from 'drizzle-kit';",
];
const RUNNER_IMPORT =
  "import { runMigrations } from '../persistence/migrations/runMigrations.ts';";

async function restrictedFor(relativePath, line) {
  const results = await eslint.lintText(`${line}\nexport {};\n`, {
    filePath: path.join(templateRoot, relativePath),
  });
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === 'no-restricted-imports')
      .map((message) => message.message)
  );
}

function sourceFiles(folder) {
  const files = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('persistence import boundary', () => {
  it('VT-07 TBI-006 NFR flags database imports outside the persistence module', async () => {
    for (const line of DRIVER_IMPORTS) {
      for (const file of [
        'apps/api/src/services/profileService.ts',
        'apps/api/src/cli/seed.ts',
        'apps/api/scripts/tool.ts',
        'apps/api/src/services/profileService.test.ts',
      ]) {
        const messages = await restrictedFor(file, line);
        expect(messages.join('\n'), `${file}: ${line}`).toContain(
          'Only apps/api/src/persistence may import the database driver or Drizzle.'
        );
      }
    }
  });

  it('VT-07 allows database imports inside persistence, drizzle.config.ts, and test', async () => {
    for (const line of DRIVER_IMPORTS) {
      for (const file of [
        'apps/api/src/persistence/appUserStore.ts',
        'apps/api/drizzle.config.ts',
        'apps/api/test/support/testDatabase.ts',
      ]) {
        expect(await restrictedFor(file, line), `${file}: ${line}`).toEqual([]);
      }
    }
  });

  it('VT-07 TBI-007 DoD-2 flags the migration runner outside the CLI, scripts, and test', async () => {
    for (const file of [
      'apps/api/src/services/profileService.ts',
      'apps/api/src/app.ts',
      'apps/api/src/persistence/index.ts',
    ]) {
      const messages = await restrictedFor(file, RUNNER_IMPORT);
      expect(messages.join('\n'), file).toContain(
        'Only the migrate command and test support may import the migration runner.'
      );
    }
    for (const file of [
      'apps/api/src/cli/migrate.ts',
      'apps/api/test/support/testDatabase.ts',
    ]) {
      expect(await restrictedFor(file, RUNNER_IMPORT), file).toEqual([]);
    }
  });

  it('VT-07 PBI-003 AC-3 no API source outside cli and persistence changes the schema', () => {
    const offenders = [];
    for (const file of sourceFiles(apiSrc)) {
      const relative = path.relative(apiSrc, file).split(path.sep).join('/');
      if (relative.startsWith('cli/') || relative.startsWith('persistence/')) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      if (/\b(?:CREATE|ALTER)\s+TABLE\b|runMigrations/i.test(text)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the committed API sources pass the boundary rules', async () => {
    const results = await eslint.lintFiles(['apps/api']);
    const errors = results.flatMap((result) =>
      result.messages
        .filter((message) => message.severity === 2)
        .map((message) => `${result.filePath}: ${message.message}`)
    );
    expect(errors).toEqual([]);
  });
});
