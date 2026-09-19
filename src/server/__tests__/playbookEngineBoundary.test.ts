/**
 * TBI-008 — the import boundary, tested rather than trusted.
 *
 * A configured lint rule and an enforced lint rule look identical in a diff. These run ESLint with
 * the repo's own config and assert what it reports, which is the difference between a boundary and
 * a comment.
 *
 * The files are virtual: `lintText` resolves configuration from the path it is given without the
 * file existing. An on-disk fixture importing an engine package would otherwise be compiled by
 * `tsc` and executed by Jest, neither of which has any business loading the engine.
 */
import path from 'path';
import { LegacyESLint } from 'eslint/use-at-your-own-risk';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WRAPPER_DIR = 'src/server/services/playbookEngine';

const ENGINE_IMPORT = `import { Mastra } from '@mastra/core';\nexport const engine = Mastra;\n`;

async function lintAs(relativeFilePath: string, source: string) {
  const eslint = new LegacyESLint({ useEslintrc: true, cwd: REPO_ROOT });
  const [result] = await eslint.lintText(source, { filePath: path.join(REPO_ROOT, relativeFilePath) });
  return result.messages;
}

interface LintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
}

const restrictedImportErrors = (messages: LintMessage[]): LintMessage[] =>
  messages.filter((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2);

describe('TBI-008 — engine imports are confined to the wrapper', () => {
  // DoD-1, VT-03
  it('fails the build when a file outside the wrapper imports an engine package', async () => {
    const messages = await lintAs('src/server/services/someOtherService.ts', ENGINE_IMPORT);
    const errors = restrictedImportErrors(messages);

    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe(2); // "error", not a warning that CI would sail past
    expect(errors[0].message).toContain('src/server/services/playbookEngine');
  });

  // DoD-1, VT-03 — the boundary is not a server-only concern
  it('fails the build for client and shared code too', async () => {
    for (const filePath of ['src/client/components/SomeView.tsx', 'src/shared/types/someType.ts']) {
      expect(restrictedImportErrors(await lintAs(filePath, ENGINE_IMPORT))).toHaveLength(1);
    }
  });

  // DoD-1, VT-03 — a type-only import reaches the engine's vocabulary just as effectively
  it('fails the build on a type-only engine import', async () => {
    const messages = await lintAs(
      'src/server/services/someOtherService.ts',
      `import type { Workflow } from '@mastra/core';\nexport type W = Workflow;\n`
    );
    expect(restrictedImportErrors(messages)).toHaveLength(1);
  });

  // DoD-1, VT-03 — the fallback engine is covered before it is ever adopted
  it('fails the build on the fallback engine package too', async () => {
    const messages = await lintAs(
      'src/server/services/someOtherService.ts',
      `import { VoltAgent } from '@voltagent/core';\nexport const a = VoltAgent;\n`
    );
    expect(restrictedImportErrors(messages)).toHaveLength(1);
  });

  // DoD-0, VT-04 — the carve-out works, so the rule is not merely blanket-denying
  it('permits engine imports inside the wrapper directory', async () => {
    const messages = await lintAs(`${WRAPPER_DIR}/someAdapter.ts`, ENGINE_IMPORT);
    expect(restrictedImportErrors(messages)).toEqual([]);
  });

  // DoD-0 — ordinary imports elsewhere are untouched by the rule
  it('leaves unrelated imports alone', async () => {
    const messages = await lintAs(
      'src/server/services/someOtherService.ts',
      `import express from 'express';\nexport const app = express();\n`
    );
    expect(restrictedImportErrors(messages)).toEqual([]);
  });
});
