import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const require = createRequire(import.meta.url);
const drizzleKitBin = path.join(
  path.dirname(require.resolve('drizzle-kit')),
  'bin.cjs'
);

export const defaultApiRoot = fileURLToPath(new URL('..', import.meta.url));

export interface ScriptArgs {
  root: string;
  rest: string[];
}

// --root points the scripts at a copy of apps/api; the tests use it.
export function parseScriptArgs(argv: readonly string[]): ScriptArgs {
  const rest: string[] = [];
  let root = defaultApiRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--root needs a directory');
      }
      root = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { root, rest };
}

export function schemaFile(root: string): string {
  return path.join(root, 'src', 'persistence', 'schema.ts');
}

export function migrationsFolder(root: string): string {
  return path.join(root, 'drizzle');
}

export interface DrizzleKitResult {
  status: number;
  output: string;
}

// Drizzle Kit 0.31 prefixes "./" to --out, so paths are passed relative to the
// output folder's parent. It also exits 0 after an uncaught error, so callers
// classify the output instead of trusting the status alone.
export function runDrizzleKit(
  command: 'generate' | 'check',
  options: { schema?: string; out: string; extra?: readonly string[] }
): DrizzleKitResult {
  const cwd = path.dirname(options.out);
  const args = [drizzleKitBin, command, '--dialect', 'postgresql'];
  if (options.schema !== undefined) {
    args.push('--schema', toPosix(path.relative(cwd, options.schema)));
  }
  args.push('--out', path.basename(options.out), ...(options.extra ?? []));
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

export type GenerateOutcome = 'written' | 'unchanged' | 'failed';

export function classifyGenerate(result: DrizzleKitResult): GenerateOutcome {
  if (result.status !== 0) {
    return 'failed';
  }
  if (result.output.includes('Your SQL migration file')) {
    return 'written';
  }
  if (result.output.includes('No schema changes')) {
    return 'unchanged';
  }
  return 'failed';
}

export function checkPassed(result: DrizzleKitResult): boolean {
  return result.status === 0 && result.output.includes("Everything's fine");
}

export function listSqlFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

// Drizzle Kit writes JSON in its own layout; Prettier owns the committed form.
export async function formatMetaFiles(folder: string): Promise<void> {
  const metaFolder = path.join(folder, 'meta');
  for (const name of readdirSync(metaFolder)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const file = path.join(metaFolder, name);
    const config = (await resolveConfig(file)) ?? {};
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, await format(text, { ...config, filepath: file }));
  }
}
