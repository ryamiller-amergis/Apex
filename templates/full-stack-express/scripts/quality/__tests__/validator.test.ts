import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFixture,
  errorLines,
  validate,
  validateFixture,
  validNfr,
  validQuality,
  warnLines,
} from './fixture.ts';

const TIMEOUT = 30_000;

function gateRow(output: string, id: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith(`${id} `));
}

describe('manifest validator', () => {
  it(
    'VT-01 TBI-027 DoD-0 TBI-029 PBI-024 AC-0: a valid fixture passes and lists 12 defined gates',
    async () => {
      const result = await validateFixture({});
      expect(result.status).toBe(0);
      expect(errorLines(result.output)).toEqual([]);
      for (const gate of validQuality().gates) {
        expect(gateRow(result.output, gate.id)).toMatch(/\sdefined\s/);
      }
      expect(validQuality().gates).toHaveLength(12);
      expect(result.output.trimEnd()).toMatch(
        /0 error\(s\), \d+ warning\(s\)$/
      );
    },
    TIMEOUT
  );

  it(
    'VT-02 PBI-024 AC-1 TBI-027 DoD-1 TBI-029 DoD-1: a missing gate script fails and names gate and script',
    async () => {
      const quality = validQuality();
      quality.gates.find((gate) => gate.id === 'lint')!.script = 'lint:all';
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const lines = errorLines(result.output);
      expect(
        lines.some(
          (line) => line.includes('"lint"') && line.includes('"lint:all"')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-03 PBI-024 AC-2 PBI-025 AC-0: a deferred gate with a missing script is a warning and the deferral is listed',
    async () => {
      const quality = validQuality();
      quality.gates.find((gate) => gate.id === 'container-build')!.script =
        'image:build';
      quality.deferrals = [
        {
          gate: 'container-build',
          reason: 'Docker is not available on the review machine',
          owner: 'platform-engineering',
        },
      ];
      const result = await validateFixture({ quality });
      expect(result.status).toBe(0);
      expect(
        warnLines(result.output).some((line) => line.includes('"image:build"'))
      ).toBe(true);
      const deferrals = result.output.split('Deferrals')[1] ?? '';
      expect(deferrals).toContain('container-build');
      expect(deferrals).toContain('platform-engineering');
      expect(deferrals).toContain(
        'Docker is not available on the review machine'
      );
    },
    TIMEOUT
  );

  it(
    'VT-04 PBI-024 AC-3 TBI-027: schedule and tier keys are rejected as unknown properties',
    async () => {
      const quality = validQuality();
      (quality.gates[0] as unknown as Record<string, unknown>).schedule =
        'nightly';
      quality.tier = 'fast';
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const lines = errorLines(result.output);
      expect(
        lines.some(
          (line) => line.includes('/gates/0') && line.includes('"schedule"')
        )
      ).toBe(true);
      expect(lines.some((line) => line.includes('"tier"'))).toBe(true);
      expect(result.output).not.toContain('nightly');
    },
    TIMEOUT
  );

  it(
    'VT-06 PBI-025 AC-1 TBI-027 DoD-3: a deferral with an empty reason fails and names the deferral',
    async () => {
      const quality = validQuality();
      quality.deferrals = [{ gate: 'unit', reason: '', owner: 'dev-team' }];
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const line = errorLines(result.output).find((entry) =>
        entry.includes('reason')
      );
      expect(line).toBeDefined();
      expect(line).toContain('deferral 0');
      expect(line).toContain('"unit"');
    },
    TIMEOUT
  );

  it(
    'VT-07 PBI-025 AC-2: a deferral for an unknown gate fails with the gate name',
    async () => {
      const quality = validQuality();
      quality.deferrals = [
        { gate: 'smoke-test', reason: 'Not built yet', owner: 'qa' },
      ];
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      expect(
        errorLines(result.output).some((line) => line.includes('smoke-test'))
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-08 PBI-025 AC-3: a deferred gate is listed as deferred, not defined or passed',
    async () => {
      const quality = validQuality();
      quality.deferrals = [
        {
          gate: 'accessibility',
          reason: 'Chromium is not installed',
          owner: 'qa-team',
        },
      ];
      const result = await validateFixture({ quality });
      expect(result.status).toBe(0);
      const row = gateRow(result.output, 'accessibility');
      expect(row).toMatch(/\sdeferred\s/);
      expect(row).not.toMatch(/\sdefined\s/);
      expect(result.output.toLowerCase()).not.toMatch(/\bpassed\b/);
      const deferrals = result.output.split('Deferrals')[1] ?? '';
      expect(deferrals).toContain('qa-team');
      expect(deferrals).toContain('Chromium is not installed');
    },
    TIMEOUT
  );

  it(
    'VT-09 PBI-025 AC-1 TBI-027 DoD-3: a deferral with a blank owner fails and names the owner field',
    async () => {
      const quality = validQuality();
      quality.deferrals = [
        { gate: 'unit', reason: 'Flaky runner', owner: '   ' },
      ];
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const line = errorLines(result.output).find((entry) =>
        entry.includes('/deferrals/0/owner')
      );
      expect(line).toContain('owner');
      expect(line).toContain('"unit"');
    },
    TIMEOUT
  );

  it(
    'VT-10 TBI-029 DoD-2: schema problems each get their own line and JSON path',
    async () => {
      const quality = validQuality();
      quality.coverage.lines = '80';
      quality.owner = 'someone';
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const lines = errorLines(result.output);
      expect(
        lines.some(
          (line) => line.includes('/coverage/lines') && line.includes('number')
        )
      ).toBe(true);
      expect(
        lines.some(
          (line) => line.includes('"owner"') && line.includes('unknown')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-11 TBI-029 DoD-3 TBI-027 DoD-2: a floor that differs from the shared config fails and names both values',
    async () => {
      const quality = validQuality();
      quality.coverage.branches = 74;
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const line = errorLines(result.output).find((entry) =>
        entry.includes('/coverage/branches')
      );
      expect(line).toContain('74');
      expect(line).toContain('75');
    },
    TIMEOUT
  );

  it(
    'VT-12 TBI-029: a member Vitest config that sets thresholds fails and names the file',
    async () => {
      const result = await validateFixture({
        memberConfig:
          'export default { test: { coverage: { thresholds: { lines: 50 } } } };\n',
      });
      expect(result.status).toBe(1);
      const lines = errorLines(result.output);
      expect(
        lines.some(
          (line) =>
            line.includes('packages/demo/vitest.config.ts') &&
            line.includes('shared floors')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-13 TBI-027 DoD-2: floors at exactly 80, 80, 80, 75 pass',
    async () => {
      const result = await validateFixture({
        floors: { lines: 80, functions: 80, statements: 80, branches: 75 },
      });
      expect(result.status).toBe(0);
      expect(result.output).not.toContain('/coverage/');
    },
    TIMEOUT
  );

  it(
    'VT-13 TBI-029 DoD-3: a missing shared floors file is an error',
    async () => {
      const fixture = buildFixture();
      try {
        rmSync(path.join(fixture.root, 'packages/config/testing.mjs'));
        const result = await validate(fixture.root);
        expect(result.status).toBe(1);
        expect(
          errorLines(result.output).some((line) => line.includes('testing.mjs'))
        ).toBe(true);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT
  );

  it(
    'VT-14 PBI-026 AC-1 TBI-028 DoD-0: an NFR target without maxMs fails and names the field',
    async () => {
      const nfr = validNfr();
      delete nfr.targets.responseTime.maxMs;
      const result = await validateFixture({ nfr });
      expect(result.status).toBe(1);
      expect(
        errorLines(result.output).some(
          (line) =>
            line.includes('/targets/responseTime') && line.includes('"maxMs"')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-15 PBI-026 AC-2 TBI-028 DoD-2: illustrative values warn per target and once more for the project',
    async () => {
      const result = await validateFixture({});
      expect(result.status).toBe(0);
      const warnings = warnLines(result.output);
      for (const target of ['responseTime', 'concurrency', 'dataVolume']) {
        expect(
          warnings.some(
            (line) =>
              line.includes(`"${target}"`) && line.includes('illustrative')
          )
        ).toBe(true);
      }
      expect(
        warnings.some((line) => line.includes('has not set real NFR targets'))
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-15 PBI-026 AC-2: a target set to illustrative false does not warn',
    async () => {
      const nfr = validNfr();
      nfr.targets.responseTime.illustrative = false;
      const result = await validateFixture({ nfr });
      const warnings = warnLines(result.output);
      expect(warnings.some((line) => line.includes('"responseTime"'))).toBe(
        false
      );
      expect(
        warnings.some((line) => line.includes('has not set real NFR targets'))
      ).toBe(false);
    },
    TIMEOUT
  );

  it(
    'VT-16 TBI-028 PBI-026: a verifiedBy path that does not exist fails and names target and path',
    async () => {
      const nfr = validNfr();
      nfr.targets.concurrency.verifiedBy = 'quality/load-test/missing.k6.js';
      const result = await validateFixture({ nfr });
      expect(result.status).toBe(1);
      expect(
        errorLines(result.output).some(
          (line) =>
            line.includes('"concurrency"') &&
            line.includes('quality/load-test/missing.k6.js')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-17 TBI-028 DoD-0: a root without the NFR manifest fails because it is required',
    async () => {
      const result = await validateFixture({ nfr: null });
      expect(result.status).toBe(1);
      expect(
        errorLines(result.output).some(
          (line) =>
            line.includes('quality/nfr-manifest.json') &&
            line.includes('missing')
        )
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-17 TBI-029: a quality manifest that is not valid JSON fails',
    async () => {
      const fixture = buildFixture();
      try {
        writeFileSync(
          path.join(fixture.root, 'quality/quality-manifest.json'),
          '{ "gates": ['
        );
        const result = await validate(fixture.root);
        expect(result.status).toBe(1);
        expect(
          errorLines(result.output).some((line) =>
            line.includes('not valid JSON')
          )
        ).toBe(true);
      } finally {
        fixture.cleanup();
      }
    },
    TIMEOUT
  );

  it(
    'VT-22 TBI-027 TBI-029: a missing core gate fails and names it',
    async () => {
      const quality = validQuality();
      quality.gates = quality.gates.filter((gate) => gate.id !== 'formatting');
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      expect(
        errorLines(result.output).some((line) => line.includes('"formatting"'))
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'VT-22 TBI-027 TBI-029: duplicate gate ids and duplicate deferrals fail',
    async () => {
      const quality = validQuality();
      quality.gates.push({
        id: 'unit',
        title: 'Unit tests again',
        script: 'test:unit',
      });
      quality.deferrals = [
        { gate: 'api', reason: 'one', owner: 'a' },
        { gate: 'api', reason: 'two', owner: 'b' },
      ];
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      const lines = errorLines(result.output);
      expect(
        lines.some((line) => line.includes('duplicate gate id "unit"'))
      ).toBe(true);
      expect(
        lines.some((line) => line.includes('"api" has more than one deferral'))
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    'PBI-025 NFR security: a schema error prints the path and rule, not the rejected value',
    async () => {
      const quality = validQuality();
      quality.gates[0].script = ' ';
      (quality.coverage as Record<string, unknown>).lines =
        'sk-live-SENTINEL-VALUE';
      const result = await validateFixture({ quality });
      expect(result.status).toBe(1);
      expect(result.output).not.toContain('SENTINEL');
    },
    TIMEOUT
  );
});
