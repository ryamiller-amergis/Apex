import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../supply-chain/run-command.mjs';
import {
  buildFixture,
  errorLines,
  readCommitted,
  runNode,
  templateRoot,
  validatorScript,
  warnLines,
  type QualityManifest,
} from './fixture.ts';

const TIMEOUT = 60_000;

function readTemplate(relative: string): string {
  return readFileSync(path.join(templateRoot, relative), 'utf8');
}

describe('committed manifests', () => {
  it(
    'VT-23 TBI-029 DoD-0 TBI-027 DoD-0: the validator passes on the committed files with illustrative warnings only',
    async () => {
      const result = await runNode([validatorScript]);
      expect(result.status).toBe(0);
      expect(errorLines(result.output)).toEqual([]);
      const warnings = warnLines(result.output);
      expect(warnings.length).toBeGreaterThan(0);
      for (const line of warnings) {
        expect(line).toMatch(/illustrative/);
      }
      const manifest = readCommitted<QualityManifest>(
        'quality/quality-manifest.json'
      );
      expect(manifest.gates).toHaveLength(12);
      expect(manifest.deferrals).toEqual([]);
    },
    TIMEOUT
  );

  it('TBI-027 DoD-1: every committed gate names a root package.json script', () => {
    const scripts = readCommitted<{ scripts: Record<string, string> }>(
      'package.json'
    ).scripts;
    for (const gate of readCommitted<QualityManifest>(
      'quality/quality-manifest.json'
    ).gates) {
      expect(scripts[gate.script], gate.id).toBeTruthy();
    }
  });

  it('VT-23 PBI-024 AC-3 PBI-026 AC-3 TBI-028 DoD-3: docs leave the schedule to each team and no script names one', () => {
    const readme = readTemplate('quality/README.md');
    expect(readme).toMatch(/each team decides when gates and load tests run/i);
    const scripts = Object.keys(
      readCommitted<{ scripts: Record<string, string> }>('package.json').scripts
    );
    for (const name of scripts) {
      expect(name).not.toMatch(/schedule|nightly|tier|cron|weekly/i);
    }
  });

  it('TBI-028 DoD-2: illustrative values are labelled in the schema, the manifest, and the docs', () => {
    const schema = JSON.parse(
      readTemplate('quality/nfr-manifest.schema.json')
    ) as {
      properties: {
        targets: { properties: Record<string, { description: string }> };
      };
    };
    for (const target of ['responseTime', 'concurrency', 'dataVolume']) {
      expect(schema.properties.targets.properties[target].description).toMatch(
        /illustrative example/i
      );
    }
    const nfr = readCommitted<{
      targets: Record<string, { illustrative: boolean }>;
    }>('quality/nfr-manifest.json');
    for (const target of Object.values(nfr.targets)) {
      expect(target.illustrative).toBe(true);
    }
    expect(readTemplate('quality/README.md')).toMatch(/illustrative examples/i);
  });
});

describe('gate-script contract', () => {
  it(
    'VT-05 PBI-024 AC-0: each gate script taken from the manifest exits 0 on success and non-zero on failure',
    async () => {
      const quality = readCommitted<QualityManifest>(
        'quality/quality-manifest.json'
      );
      quality.gates.push(
        { id: 'passing-gate', title: 'Exits 0', script: 'ok' },
        { id: 'failing-gate', title: 'Exits 1', script: 'bad' }
      );
      const scripts: Record<string, string> = Object.fromEntries(
        quality.gates.map((gate) => [gate.script, 'node -e ""'])
      );
      scripts.ok = 'node -e "process.exit(0)"';
      scripts.bad = 'node -e "process.exit(1)"';
      const fixture = buildFixture({ quality, scripts });
      try {
        const manifest = JSON.parse(
          readFileSync(
            path.join(fixture.root, 'quality/quality-manifest.json'),
            'utf8'
          )
        ) as QualityManifest;
        const status: Record<string, number | null> = {};
        for (const id of ['passing-gate', 'failing-gate']) {
          const gate = manifest.gates.find((entry) => entry.id === id)!;
          const run = await runCommand(
            'corepack',
            ['pnpm', 'run', gate.script],
            {
              cwd: fixture.root,
            }
          );
          status[id] = run.status;
        }
        expect(status['passing-gate']).toBe(0);
        expect(status['failing-gate']).not.toBe(0);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT
  );
});
