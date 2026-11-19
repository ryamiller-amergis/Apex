/**
 * TBI-004 (DoD-0, DoD-1, DoD-2) & PBI-003 (AC-0, AC-1, AC-2, AC-3):
 * RED -> GREEN suite for `scripts/chat-harness-baseline/record.mjs` and `compare.mjs`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAT_AREA_IDS, type ChatAreaId } from '../../shared/types/chatHarness';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BASELINE_DIR = path.join(REPO_ROOT, 'scripts', 'chat-harness-baseline');
const RECORD_SCRIPT = path.join(BASELINE_DIR, 'record.mjs');
const COMPARE_SCRIPT = path.join(BASELINE_DIR, 'compare.mjs');
const CHECKED_IN_BASELINE = path.join(BASELINE_DIR, 'baseline.json');

const DURABLE_ACQUISITION_AREAS = new Set<ChatAreaId>([
  'agent-home',
  'interview',
  'adr',
  'prd-assistant',
  'design-doc-assistant',
  'brainstorm',
  'cab-release',
  'build-intake',
]);

function makeAppInsightsFixture(sampleCount = 260) {
  return {
    sdkVersion: '1.4.0',
    windowStart: '2026-11-18T00:00:00.000Z',
    windowEnd: '2026-11-18T12:00:00.000Z',
    deployInWindow: false,
    deployWindowNote: 'Recorded on old paths running @cursor/sdk 1.4.0 prior to harness deploy.',
    areas: Object.fromEntries(
      CHAT_AREA_IDS.map((area) => [
        area,
        {
          send_to_feedback: { p95Ms: 145, sampleCount },
          first_token: { p95Ms: 1_850, sampleCount },
          longest_gap: { p95Ms: 1_620, sampleCount },
          stop: { p95Ms: 240, sampleCount },
          reconnect_restored: { p95Ms: 1_150, sampleCount },
          ...(DURABLE_ACQUISITION_AREAS.has(area)
            ? {
                acquisition_mode: {
                  warmOrResumedRate: 0.994,
                  recreatedRate: 0.006,
                  sampleCount,
                },
              }
            : {}),
          // Deliberately include stray text to prove recorder strips message content (PBI-003 AC-3)
          text: 'Must never persist to baseline.json',
        },
      ]),
    ),
  };
}

describe('chat harness baseline recorder and comparator (TBI-004 / PBI-003)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'apex-chat-baseline-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('TBI-004 DoD-0 / DoD-1 / DoD-2 / PBI-003 AC-3 / VT-29: record.mjs writes baseline.json for all 13 areas with documented exceptions, deploy-window note, and zero message text', () => {
    const inputPath = path.join(tempDir, 'appinsights-export.json');
    const outPath = path.join(tempDir, 'baseline.json');
    writeFileSync(inputPath, JSON.stringify(makeAppInsightsFixture(250), null, 2), 'utf8');

    const res = spawnSync(
      process.execPath,
      [RECORD_SCRIPT, '--input', inputPath, '--output', outPath],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(res.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const raw = readFileSync(outPath, 'utf8');
    expect(raw).not.toContain('Must never persist');
    const parsed = JSON.parse(raw) as {
      sdkVersion: string;
      deployInWindow: boolean;
      deployWindowNote: string;
      areas: Record<string, { targets: Record<string, { status: string }> }>;
    };

    expect(parsed.sdkVersion).toBe('1.4.0');
    expect(typeof parsed.deployInWindow).toBe('boolean');
    expect(parsed.deployWindowNote.length).toBeGreaterThan(10);
    expect(Object.keys(parsed.areas).sort()).toEqual([...CHAT_AREA_IDS].sort());

    for (const area of CHAT_AREA_IDS) {
      const targets = parsed.areas[area].targets;
      expect(targets.send_to_feedback.status).toBe('recorded');
      expect(targets.first_token.status).toBe('recorded');
      expect(targets.longest_gap.status).toBe('recorded');
      expect(targets.stop.status).toBe('recorded');
      expect(targets.reconnect_restored.status).toBe('recorded');
      if (DURABLE_ACQUISITION_AREAS.has(area)) {
        expect(targets.acquisition_mode.status).toBe('recorded');
      } else {
        expect(targets.acquisition_mode.status).toBe(
          'not applicable: no acquisition ladder',
        );
      }
    }

    // Checked-in baseline file exists where CI release checks read it (TBI-004 DoD-1).
    expect(existsSync(CHECKED_IN_BASELINE)).toBe(true);
  });

  it('PBI-003 AC-0 / VT-29: compare.mjs prints each target, baseline value, and current value side by side and exits 0 when all 13 areas pass', () => {
    const inputPath = path.join(tempDir, 'fixture.json');
    const baselinePath = path.join(tempDir, 'baseline.json');
    writeFileSync(inputPath, JSON.stringify(makeAppInsightsFixture(260), null, 2), 'utf8');
    spawnSync(process.execPath, [RECORD_SCRIPT, '--input', inputPath, '--output', baselinePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    const currentPath = path.join(tempDir, 'current.json');
    spawnSync(process.execPath, [RECORD_SCRIPT, '--input', inputPath, '--output', currentPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    const compare = spawnSync(
      process.execPath,
      [COMPARE_SCRIPT, '--baseline', baselinePath, '--current', currentPath],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(compare.status).toBe(0);
    expect(compare.stdout).toContain('agent-home');
    expect(compare.stdout).toContain('brainstorm');
    expect(compare.stdout).toContain('send_to_feedback');
    expect(compare.stdout).toContain('145 ms');
    expect(compare.stdout).toContain('PASS');
  });

  it('PBI-003 AC-1 / VT-30: compare.mjs marks a missing area baseline and exits non-zero to block release', () => {
    const inputPath = path.join(tempDir, 'fixture.json');
    const baselinePath = path.join(tempDir, 'baseline.json');
    const currentPath = path.join(tempDir, 'current.json');
    writeFileSync(inputPath, JSON.stringify(makeAppInsightsFixture(260), null, 2), 'utf8');

    spawnSync(process.execPath, [RECORD_SCRIPT, '--input', inputPath, '--output', baselinePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    spawnSync(process.execPath, [RECORD_SCRIPT, '--input', inputPath, '--output', currentPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    const tampered = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      areas: Record<string, unknown>;
    };
    delete tampered.areas['qa-lab'];
    writeFileSync(baselinePath, JSON.stringify(tampered, null, 2), 'utf8');

    const compare = spawnSync(
      process.execPath,
      [COMPARE_SCRIPT, '--baseline', baselinePath, '--current', currentPath],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(compare.status).not.toBe(0);
    expect(`${compare.stdout}\n${compare.stderr}`).toMatch(/qa-lab.*MISSING BASELINE/i);
  });

  it('PBI-003 AC-2 / VT-31: compare.mjs flags LOW SAMPLE (< 200 turns) rather than counting the area as a pass', () => {
    const highInput = path.join(tempDir, 'high.json');
    const lowInput = path.join(tempDir, 'low.json');
    const baselinePath = path.join(tempDir, 'baseline.json');
    const currentPath = path.join(tempDir, 'current.json');
    writeFileSync(highInput, JSON.stringify(makeAppInsightsFixture(260), null, 2), 'utf8');
    writeFileSync(lowInput, JSON.stringify(makeAppInsightsFixture(50), null, 2), 'utf8');

    spawnSync(process.execPath, [RECORD_SCRIPT, '--input', highInput, '--output', baselinePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    spawnSync(process.execPath, [RECORD_SCRIPT, '--input', lowInput, '--output', currentPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    const compare = spawnSync(
      process.execPath,
      [COMPARE_SCRIPT, '--baseline', baselinePath, '--current', currentPath],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(compare.status).not.toBe(0);
    expect(compare.stdout).toContain('LOW SAMPLE');
  });
});
