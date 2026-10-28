import { spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const templateRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
export const validatorScript = path.join(
  templateRoot,
  'scripts/quality/validate-manifests.mjs'
);
export const runnerScript = path.join(
  templateRoot,
  'scripts/quality/run-load-test.mjs'
);

export interface Gate {
  id: string;
  title: string;
  script: string;
}

export interface Deferral {
  gate: unknown;
  reason?: unknown;
  owner?: unknown;
}

export interface QualityManifest {
  $schema?: string;
  schemaVersion: number;
  coverage: Record<string, unknown>;
  gates: Gate[];
  deferrals: Deferral[];
  [key: string]: unknown;
}

export interface NfrManifest {
  $schema?: string;
  schemaVersion: number;
  targets: Record<string, Record<string, unknown>>;
}

export function readCommitted<T>(relative: string): T {
  return JSON.parse(
    readFileSync(path.join(templateRoot, relative), 'utf8')
  ) as T;
}

/** A valid quality manifest: the committed gates and no deferrals. */
export function validQuality(): QualityManifest {
  return readCommitted<QualityManifest>('quality/quality-manifest.json');
}

export function validNfr(): NfrManifest {
  return readCommitted<NfrManifest>('quality/nfr-manifest.json');
}

export interface FixtureOptions {
  quality?: QualityManifest | null;
  nfr?: NfrManifest | null;
  scripts?: Record<string, string>;
  floors?: Record<string, number>;
  memberConfig?: string;
}

const MEMBER_CONFIG = `import { defineTestProject } from '@project-scope/config/testing';
export default defineTestProject({ name: 'unit', environment: 'node' });
`;

/**
 * Builds a throwaway template root from a valid fixture. Pass one mutation to
 * prove one rule. Call the returned cleanup when done.
 */
export function buildFixture(options: FixtureOptions = {}): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'feat-012-quality-'));
  const quality =
    options.quality === undefined ? validQuality() : options.quality;
  const nfr = options.nfr === undefined ? validNfr() : options.nfr;
  const scripts =
    options.scripts ??
    Object.fromEntries(
      validQuality().gates.map((gate) => [gate.script, 'node -e ""'])
    );

  mkdirSync(path.join(root, 'quality', 'load-test'), { recursive: true });
  for (const schema of [
    'quality-manifest.schema.json',
    'nfr-manifest.schema.json',
  ]) {
    copyFileSync(
      path.join(templateRoot, 'quality', schema),
      path.join(root, 'quality', schema)
    );
  }
  writeFileSync(
    path.join(root, 'quality', 'load-test', 'profile-read.k6.js'),
    ''
  );
  if (quality) {
    writeJson(path.join(root, 'quality', 'quality-manifest.json'), quality);
  }
  if (nfr) {
    writeJson(path.join(root, 'quality', 'nfr-manifest.json'), nfr);
  }
  writeJson(path.join(root, 'package.json'), {
    name: 'fixture',
    private: true,
    packageManager: readCommitted<{ packageManager: string }>('package.json')
      .packageManager,
    scripts,
  });
  writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n"
  );

  const configDir = path.join(root, 'packages', 'config');
  mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'package.json'), {
    name: '@project-scope/config',
  });
  const floors = options.floors ?? {
    lines: 80,
    functions: 80,
    statements: 80,
    branches: 75,
  };
  writeFileSync(
    path.join(configDir, 'testing.mjs'),
    `export const coverageFloors = Object.freeze(${JSON.stringify(floors)});\n`
  );
  writeFileSync(
    path.join(configDir, 'vitest.config.mjs'),
    "import { defineTestProject } from './testing.mjs';\nexport default defineTestProject;\n"
  );

  const memberDir = path.join(root, 'packages', 'demo');
  mkdirSync(memberDir, { recursive: true });
  writeJson(path.join(memberDir, 'package.json'), {
    name: '@project-scope/demo',
  });
  writeFileSync(
    path.join(memberDir, 'vitest.config.ts'),
    options.memberConfig ?? MEMBER_CONFIG
  );

  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface CommandOutput {
  status: number;
  output: string;
}

export function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
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
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, output }));
  });
}

export async function validate(root: string): Promise<CommandOutput> {
  return runNode([validatorScript, '--root', root]);
}

/** Runs the validator on a fixture built from one mutation. */
export async function validateFixture(
  options: FixtureOptions
): Promise<CommandOutput> {
  const fixture = buildFixture(options);
  try {
    return await validate(fixture.root);
  } finally {
    fixture.cleanup();
  }
}

export function errorLines(output: string): string[] {
  return output.split('\n').filter((line) => line.startsWith('ERROR '));
}

export function warnLines(output: string): string[] {
  return output.split('\n').filter((line) => line.startsWith('WARN '));
}
