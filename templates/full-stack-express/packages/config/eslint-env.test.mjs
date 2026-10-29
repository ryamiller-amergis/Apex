import { ESLint } from 'eslint';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const templateRoot = path.resolve(import.meta.dirname, '../..');

const eslint = new ESLint({
  cwd: templateRoot,
  overrideConfigFile: path.join(templateRoot, 'eslint.config.mjs'),
});

async function messagesFor(filePath, text) {
  const results = await eslint.lintText(text, { filePath });
  return results.flatMap((result) =>
    result.messages.map((message) => message.message)
  );
}

describe('environment read restrictions', () => {
  it('S8 flags process.env outside the API config module', async () => {
    const messages = await messagesFor(
      path.join(templateRoot, 'apps/api/src/leak.ts'),
      'export const leaked = process.env.DATABASE_URL;\n'
    );
    expect(messages.join('\n')).toContain(
      'Read process.env only in apps/api/src/config/env.ts.'
    );
  });

  it('S8 flags import.meta.env outside the web config module', async () => {
    const messages = await messagesFor(
      path.join(templateRoot, 'apps/web/src/leak.ts'),
      'export const leaked = import.meta.env.VITE_APP_NAME;\n'
    );
    expect(messages.join('\n')).toContain(
      'Read import.meta.env only in apps/web/src/config/env.ts.'
    );
  });

  it('S8 allows the two config modules to read their own environment', async () => {
    const results = await eslint.lintFiles([
      'apps/api/src/config/env.ts',
      'apps/api/src/index.ts',
      'apps/web/src/config/env.ts',
      'apps/web/src/config/webEnvSchema.ts',
      'apps/web/vite.config.ts',
    ]);
    const errors = results.flatMap((result) =>
      result.messages
        .filter((message) => message.severity === 2)
        .map((message) => `${result.filePath}: ${message.message}`)
    );
    expect(errors).toEqual([]);
  });
});
