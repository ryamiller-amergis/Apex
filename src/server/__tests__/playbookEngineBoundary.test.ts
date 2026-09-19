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
import fs from 'fs';
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

/**
 * TBI-015 DoD-3 — nothing outside the wrapper reads an engine-owned table.
 *
 * The import rule above stops code getting hold of the engine's client. It does not stop a raw SQL
 * string naming an engine table through Apex's own pool, and that route would break exit criterion
 * E4 just as thoroughly while passing every lint check. So the boundary has a second half: no file
 * outside the wrapper may name the engine's schema or its table prefix at all.
 *
 * A source scan rather than a lint rule, because what is being forbidden is a substring in a
 * string literal, which is not something `no-restricted-imports` can see.
 */
describe('TBI-015 — the engine store is unreachable outside the wrapper', () => {
  /** The schema the TBI-014 migration confines the engine to, and the prefix its tables carry. */
  const ENGINE_STORE_MARKERS = ['playbook_engine', 'mastra_'];
  const SOURCE_ROOTS = ['src/client', 'src/server', 'src/shared'];

  /**
   * Comments are stripped before matching. What is forbidden is naming the engine's store in a
   * query; a doc comment explaining why this file does not touch it is the opposite of a violation,
   * and a check that flags both teaches people to stop writing the explanation.
   *
   * Crude by design — it does not parse. A SQL string naming an engine table contains no comment
   * delimiter, so it survives stripping intact, which is the case that matters.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  function sourceFilesUnder(relativeDir: string): string[] {
    const absolute = path.join(REPO_ROOT, relativeDir);
    if (!fs.existsSync(absolute)) return [];

    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(relativeDir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) return sourceFilesUnder(child);
      return /\.tsx?$/.test(entry.name) ? [child] : [];
    });
  }

  const filesOutsideWrapper = SOURCE_ROOTS.flatMap(sourceFilesUnder).filter(
    (file) => !file.startsWith(`${WRAPPER_DIR}/`) && !file.endsWith('playbookEngineBoundary.test.ts')
  );

  it('finds no reference to the engine schema or its tables anywhere outside the wrapper', () => {
    const offenders = filesOutsideWrapper.filter((file) => {
      const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      return ENGINE_STORE_MARKERS.some((marker) => code.includes(marker));
    });

    expect(offenders).toEqual([]);
  });

  it('would catch a query that reached into the engine store', () => {
    // The scan is only worth having if it fires. Both halves of the marker list, in code rather
    // than in a comment, which is the distinction the stripper exists to draw.
    const reaching = `const rows = await pool.query('SELECT * FROM playbook_engine.mastra_evals');`;
    expect(ENGINE_STORE_MARKERS.some((m) => stripComments(reaching).includes(m))).toBe(true);

    const explaining = `// never read from playbook_engine or any mastra_ table\nconst a = 1;`;
    expect(ENGINE_STORE_MARKERS.some((m) => stripComments(explaining).includes(m))).toBe(false);
  });

  it('scanned a plausible number of files, so an empty result means something', () => {
    // A path typo would make the scan above vacuously pass. This is the guard on the guard.
    expect(filesOutsideWrapper.length).toBeGreaterThan(100);
    expect(filesOutsideWrapper).toContain('src/server/services/playbookRunProjectionService.ts');
  });

  it('keeps the projection service itself clear of the engine, as shipped', async () => {
    const relativePath = 'src/server/services/playbookRunProjectionService.ts';
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

    // Linted as its real self rather than a fixture: this is the file E4 depends on.
    expect(restrictedImportErrors(await lintAs(relativePath, source))).toEqual([]);
    expect(stripComments(source)).not.toContain('playbookEngine');
  });
});
