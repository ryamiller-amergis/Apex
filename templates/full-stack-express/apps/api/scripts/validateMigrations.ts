import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkPassed,
  classifyGenerate,
  listSqlFiles,
  migrationsFolder,
  parseScriptArgs,
  runDrizzleKit,
  schemaFile,
} from './drizzleKit.ts';

// Needs no database. Generates into a scratch copy of the committed folder;
// any new file there is the migration the developer has not generated yet.

const MATCH = 'Migrations match the Drizzle schema.';
const DRIFT =
  'Schema differs from committed migrations. Run "pnpm db:generate" and commit the result.';
const INCONSISTENT =
  'Committed migrations are inconsistent. Do not edit generated files by hand; see docs/runbooks/migrations.md.';

function compareWithSchema(root: string, committed: string): string[] | null {
  const scratch = mkdtempSync(path.join(tmpdir(), 'migrate-validate-'));
  try {
    const scratchFolder = path.join(scratch, 'drizzle');
    cpSync(committed, scratchFolder, { recursive: true });
    const before = new Set(listSqlFiles(scratchFolder));
    const generated = runDrizzleKit('generate', {
      schema: schemaFile(root),
      out: scratchFolder,
      extra: ['--name', 'pending_schema_change'],
    });
    const outcome = classifyGenerate(generated);
    if (outcome === 'failed') {
      return [generated.output.trim(), 'Migration validation could not run.'];
    }
    const added = listSqlFiles(scratchFolder).filter(
      (name) => !before.has(name)
    );
    if (outcome === 'unchanged' && added.length === 0) {
      return null;
    }
    return [
      DRIFT,
      ...added.map((name) =>
        readFileSync(path.join(scratchFolder, name), 'utf8').trim()
      ),
    ];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv: readonly string[]): number {
  const { root } = parseScriptArgs(argv);
  const committed = migrationsFolder(root);

  const check = runDrizzleKit('check', { out: committed });
  const problems = checkPassed(check)
    ? compareWithSchema(root, committed)
    : [check.output.trim(), INCONSISTENT];

  if (problems === null) {
    process.stdout.write(`${MATCH}\n`);
    return 0;
  }
  process.stderr.write(`${problems.join('\n')}\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
