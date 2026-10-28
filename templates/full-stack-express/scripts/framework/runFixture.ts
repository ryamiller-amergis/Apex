import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const templateRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const vitestEntry = path.join(
  templateRoot,
  'node_modules',
  'vitest',
  'vitest.mjs'
);
const testingHref = pathToFileURL(
  path.join(templateRoot, 'packages', 'config', 'testing.mjs')
).href;

export interface CommandOutput {
  status: number;
  output: string;
}

export function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? templateRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out\n${output}`));
    }, options.timeoutMs ?? 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, output });
    });
  });
}

export function branchSource(options: {
  both: number;
  oneSided: number;
  straight: number;
  unused: number;
}): { source: string; test: string } {
  const functions = options.both + options.oneSided;
  const source: string[] = [];
  for (let index = 0; index < functions; index += 1) {
    source.push(
      `export function b${index}(flag: boolean): number {`,
      '  if (flag) return 1;',
      '  return 0;',
      '}'
    );
  }
  for (let index = 0; index < options.straight; index += 1) {
    source.push(`export function s${index}(): number { return ${index}; }`);
  }
  for (let index = 0; index < options.unused; index += 1) {
    source.push(`export function u${index}(): number { return ${index}; }`);
  }
  const calls: string[] = ['import { expect, it } from "vitest";'];
  const imported: string[] = [];
  for (let index = 0; index < functions; index += 1) {
    imported.push(`b${index}`);
  }
  for (let index = 0; index < options.straight; index += 1) {
    imported.push(`s${index}`);
  }
  calls.push(`import { ${imported.join(', ')} } from "./subject.ts";`);
  calls.push('it("covers the fixture", () => {');
  for (let index = 0; index < options.both; index += 1) {
    calls.push(`  expect(b${index}(true)).toBe(1);`);
    calls.push(`  expect(b${index}(false)).toBe(0);`);
  }
  for (let index = options.both; index < functions; index += 1) {
    calls.push(`  expect(b${index}(true)).toBe(1);`);
  }
  for (let index = 0; index < options.straight; index += 1) {
    calls.push(`  expect(s${index}()).toBe(${index});`);
  }
  calls.push('});');
  return { source: source.join('\n'), test: calls.join('\n') };
}

export async function runCoverageSource(
  source: string,
  test: string
): Promise<CommandOutput & { summary: Record<string, { pct: number }> }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-cov-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'subject.ts'), source);
  writeFileSync(path.join(dir, 'src', 'subject.test.ts'), test);
  const configPath = path.join(dir, 'vitest.config.ts');
  const rootLiteral = JSON.stringify(dir);
  const reportLiteral = JSON.stringify(path.join(dir, 'coverage'));
  writeFileSync(
    configPath,
    `import { coverageFloors } from ${JSON.stringify(testingHref)};
export default {
  root: ${rootLiteral},
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: ${reportLiteral},
      include: ['src/subject.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: coverageFloors,
    },
  },
};
`
  );
  try {
    const result = await runNode(
      [vitestEntry, 'run', '--coverage', '--config', configPath],
      { cwd: templateRoot, timeoutMs: 90_000 }
    );
    const summaryPath = path.join(dir, 'coverage', 'coverage-summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      total: Record<string, { pct: number }>;
    };
    return { ...result, summary: summary.total };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCoverageFixture(shape: {
  both: number;
  oneSided: number;
  straight: number;
  unused: number;
}): Promise<CommandOutput & { summary: Record<string, { pct: number }> }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'feat-011-cov-'));
  mkdirSync(path.join(dir, 'src'));
  const generated = branchSource(shape);
  writeFileSync(path.join(dir, 'src', 'subject.ts'), generated.source);
  writeFileSync(path.join(dir, 'src', 'subject.test.ts'), generated.test);
  const configPath = path.join(dir, 'vitest.config.ts');
  const rootLiteral = JSON.stringify(dir);
  const reportLiteral = JSON.stringify(path.join(dir, 'coverage'));
  writeFileSync(
    configPath,
    `import { coverageFloors } from ${JSON.stringify(testingHref)};
export default {
  root: ${rootLiteral},
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: ${reportLiteral},
      include: ['src/subject.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: coverageFloors,
    },
  },
};
`
  );
  try {
    const result = await runNode(
      [vitestEntry, 'run', '--coverage', '--config', configPath],
      { cwd: templateRoot, timeoutMs: 90_000 }
    );
    const summaryPath = path.join(dir, 'coverage', 'coverage-summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      total: Record<string, { pct: number }>;
    };
    return { ...result, summary: summary.total };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const templateRootDir = templateRoot;
export const vitestBin = vitestEntry;
