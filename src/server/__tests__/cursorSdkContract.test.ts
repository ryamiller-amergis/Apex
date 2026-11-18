import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const generatorPath = path.join(
  repoRoot,
  'scripts',
  'cursor-sdk-contract',
  'generate.mjs'
);
const fixturePath = path.join(
  repoRoot,
  'scripts',
  'cursor-sdk-contract',
  'cursor-sdk-1.4.0.contract.json'
);

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

describe('Cursor SDK installed contract (TBI-001)', () => {
  it('DoD-0 VT-01 — manifest and lock pin SDK 1.4.0 exactly', () => {
    const manifest = readJson(path.join(repoRoot, 'package.json')) as {
      dependencies: Record<string, string>;
    };
    const lock = readJson(path.join(repoRoot, 'package-lock.json')) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };

    expect(manifest.dependencies['@cursor/sdk']).toBe('1.4.0');
    expect(lock.packages[''].dependencies?.['@cursor/sdk']).toBe('1.4.0');
    expect(lock.packages['node_modules/@cursor/sdk'].version).toBe('1.4.0');
  });

  it('DoD-0 — 1.4.0 drops CursorSDK and exports Agent and Cursor', async () => {
    const sdk = (await import('@cursor/sdk')) as {
      CursorSDK?: unknown;
      Agent?: unknown;
      Cursor?: unknown;
    };
    expect(sdk.CursorSDK).toBeUndefined();
    expect(typeof sdk.Agent).toBe('function');
    expect(typeof sdk.Cursor).toBe('function');
  });

  it('VT-02 — generated Agent/LocalAgent/sandbox/settings snapshot matches fixture', () => {
    const generated = spawnSync(process.execPath, [generatorPath, '--stdout'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(generated.stderr).toBe('');
    expect(generated.status).toBe(0);

    const snapshot = JSON.parse(generated.stdout) as {
      package: { name: string; version: string };
      contracts: Record<
        string,
        { declarations: unknown[]; sourceFiles: string[] }
      >;
    };
    expect(snapshot).toEqual(readJson(fixturePath));
    expect(snapshot.package).toEqual({
      name: '@cursor/sdk',
      version: '1.4.0',
    });

    for (const area of ['Agent', 'LocalAgent', 'sandbox', 'trustedSettings']) {
      expect(snapshot.contracts[area]?.declarations.length).toBeGreaterThan(0);
      expect(snapshot.contracts[area]?.sourceFiles.length).toBeGreaterThan(0);
      for (const sourceFile of snapshot.contracts[area].sourceFiles) {
        expect(path.isAbsolute(sourceFile)).toBe(false);
        expect(sourceFile).not.toContain('\\');
      }
    }
  });
});
