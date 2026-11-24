/**
 * W7-B / S11 — TDD unit tests for `scripts/chat-harness-release-check.ts`.
 *
 * Covers:
 *  - VT-33 / PBI-019 AC-0: All 12 HARNESS_AREA_IDS pass contracts, timing
 *    targets, baseline checks (including calendar-work-item -> calendar-assistant),
 *    and production targets -> exitCode 0 with plain-text side-by-side report.
 *  - VT-34 / PBI-019 AC-1: Any area missing a timing target, failing contract
 *    tests, or reporting lost/doubled messages -> exitCode 1, naming area & target.
 *  - VT-35 / PBI-019 AC-2: deployInWindow === false -> postDeployVerified: false
 *    and report explicitly flags "post-deploy 5% bound is not yet verified";
 *    deployInWindow === true with rate > 5% fails release check.
 *  - VT-36 / PBI-019 AC-3: weeklyRecreatedRate > 0.02 over a week outside deploys
 *    -> exitCode 1, escalationTriggered: true, flags LocalAgentStore escalation,
 *    lists all 6 recreate reasons, and fails any reason above its share limit.
 *  - VT-37 / PBI-019 (e): Missing area or required target in baseline -> exitCode 1
 *    naming area and target with "MISSING BASELINE".
 *  - BR-007 / PBI-019 NFR: Report never includes message, prompt, steer, or
 *    summary text.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_AREA_IDS,
  HARNESS_RECREATE_REASONS,
  type HarnessAreaId,
  type HarnessRecreateReason,
} from '../../../shared/types/chatHarness';

type CiTimingTarget =
  | 'send_to_first_feedback'
  | 'apex_overhead_warm'
  | 'first_token_warm'
  | 'first_token_new_chat'
  | 'progress_step_new_chat'
  | 'longest_silent_gap'
  | 'stop_ui_halt'
  | 'stop_confirmed'
  | 'steer_acknowledged'
  | 'reconnect_restored'
  | 'reload_restored';

interface BaselineTimingCell {
  status: string;
  p95Ms: number | null;
  sampleCount?: number;
}

interface BaselineAreaEntry {
  targets: Record<string, BaselineTimingCell | Record<string, unknown>>;
}

interface BaselineDocument {
  schemaVersion?: number;
  sdkVersion?: string;
  windowStart?: string;
  windowEnd?: string;
  deployInWindow?: boolean;
  deployWindowNote?: string;
  areas: Record<string, BaselineAreaEntry>;
}

interface CiAreaResult {
  contractPassed: boolean;
  failedScenarios?: string[];
  timingsMs: Partial<Record<CiTimingTarget, number>>;
  noLostOrDoubledMessages?: boolean;
}

interface CiGateInput {
  areas: Partial<Record<HarnessAreaId, CiAreaResult>>;
}

interface ProductionGateInput {
  windowDays: number;
  deployInWindow: boolean;
  fullMemoryShare: number;
  weeklyRecreatedRate: number;
  postDeployRecreatedRate?: number | null;
  apexControlledFailureRate: number;
  recreatedByReason: Partial<Record<HarnessRecreateReason, number>>;
  reasonShareLimits?: Partial<Record<HarnessRecreateReason, number>>;
}

interface ReleaseCheckInput {
  baseline: BaselineDocument;
  ci?: CiGateInput;
  production?: ProductionGateInput;
  mode?: 'full' | 'ci-only' | 'prod-only';
}

interface ReleaseCheckFailure {
  gate: 'baseline' | 'ci' | 'production';
  area?: HarnessAreaId;
  target: string;
  code: string;
  message: string;
}

interface ReleaseCheckResult {
  ok: boolean;
  exitCode: 0 | 1;
  report: string;
  failures: ReleaseCheckFailure[];
  flags: string[];
  escalationTriggered: boolean;
  postDeployVerified: boolean;
}

interface ReleaseCheckModule {
  CI_TIMING_THRESHOLDS_MS: Readonly<Record<CiTimingTarget, number>>;
  CI_TIMING_TARGETS: readonly CiTimingTarget[];
  evaluateChatHarnessReleaseCheck: (input: ReleaseCheckInput) => ReleaseCheckResult;
  runReleaseCheckCli: (argv: string[]) => ReleaseCheckResult;
}

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'chat-harness-release-check');
const CHECKED_IN_BASELINE_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'chat-harness-baseline',
  'baseline.json',
);

function loadReleaseCheckModule(): ReleaseCheckModule {
  // Loaded dynamically so tsconfig.server.json (rootDir: ./src) does not pull scripts/ into dist.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(SCRIPT_PATH) as ReleaseCheckModule;
}

function loadCheckedInBaseline(): BaselineDocument {
  return JSON.parse(readFileSync(CHECKED_IN_BASELINE_PATH, 'utf8')) as BaselineDocument;
}

function makePassingTimings(): Record<CiTimingTarget, number> {
  return {
    send_to_first_feedback: 145,
    apex_overhead_warm: 320,
    first_token_warm: 1_900,
    first_token_new_chat: 4_800,
    progress_step_new_chat: 650,
    longest_silent_gap: 1_450,
    stop_ui_halt: 180,
    stop_confirmed: 950,
    steer_acknowledged: 280,
    reconnect_restored: 1_100,
    reload_restored: 1_250,
  };
}

function makePassingCiInput(): CiGateInput {
  const areas: Partial<Record<HarnessAreaId, CiAreaResult>> = {};
  for (const area of HARNESS_AREA_IDS) {
    areas[area] = {
      contractPassed: true,
      noLostOrDoubledMessages: true,
      timingsMs: makePassingTimings(),
    };
  }
  return { areas };
}

function makePassingProdInput(
  overrides: Partial<ProductionGateInput> = {},
): ProductionGateInput {
  return {
    windowDays: 7,
    deployInWindow: true,
    fullMemoryShare: 0.994,
    weeklyRecreatedRate: 0.006,
    postDeployRecreatedRate: 0.024,
    apexControlledFailureRate: 0.004,
    recreatedByReason: {
      deploy: 12,
      'folder-change': 2,
      'replica-move': 1,
      'sdk-version': 0,
      'idle-eviction': 5,
      unknown: 0,
    },
    reasonShareLimits: {
      'replica-move': 0.25,
      unknown: 0.1,
    },
    ...overrides,
  };
}

describe('scripts/chat-harness-release-check (S11 / PBI-019 VT-33..VT-37)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'apex-release-check-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('VT-33 / PBI-019 AC-0: passes with exitCode 0 when all 12 harness areas pass contracts, meet all 11 timing targets vs baseline, and prod targets pass', () => {
    const { evaluateChatHarnessReleaseCheck, CI_TIMING_TARGETS } =
      loadReleaseCheckModule();

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci: makePassingCiInput(),
      production: makePassingProdInput(),
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.escalationTriggered).toBe(false);
    expect(result.postDeployVerified).toBe(true);

    // Every harness area (including calendar-work-item resolved from calendar-assistant) appears in the report.
    for (const area of HARNESS_AREA_IDS) {
      expect(result.report).toContain(area);
    }
    // Every timing target appears side-by-side with baseline, current, and threshold.
    for (const target of CI_TIMING_TARGETS) {
      expect(result.report).toContain(target);
    }
    expect(result.report).toContain('152 ms'); // calendar-assistant seed baseline mapped to calendar-work-item
    expect(result.report).toContain('<= 200 ms');
    expect(result.report).toContain('<= 2000 ms');
    expect(result.report).toContain('PASS');
  });

  it('VT-34 / PBI-019 AC-1: fails with exitCode 1 and explicitly names area and missed timing target', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();
    const ci = makePassingCiInput();
    ci.areas['qa-lab']!.timingsMs.longest_silent_gap = 2_450;

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci,
      production: makePassingProdInput(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(
      result.failures.some(
        (f) => f.area === 'qa-lab' && f.target === 'longest_silent_gap',
      ),
    ).toBe(true);
    expect(result.report).toMatch(/qa-lab[\s\S]*longest_silent_gap[\s\S]*2450 ms[\s\S]*FAIL/);
  });

  it('VT-34 / PBI-019 AC-1: fails with exitCode 1 when an area fails contract tests or reports lost/doubled messages', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();
    const ci = makePassingCiInput();
    ci.areas['brainstorm'] = {
      ...ci.areas['brainstorm']!,
      contractPassed: false,
      failedScenarios: ['steer-mid-turn'],
      noLostOrDoubledMessages: false,
    };

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci,
      production: makePassingProdInput(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(
      result.failures.some((f) => f.area === 'brainstorm' && f.code === 'CONTRACT_FAILED'),
    ).toBe(true);
    expect(
      result.failures.some(
        (f) => f.area === 'brainstorm' && f.code === 'MESSAGE_INTEGRITY_FAILED',
      ),
    ).toBe(true);
    expect(result.report).toContain('brainstorm');
    expect(result.report).toContain('steer-mid-turn');
  });

  it('VT-34 / PBI-019 AC-1: fails with exitCode 1 when an area omits noLostOrDoubledMessages', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();
    const ci = makePassingCiInput();
    const { noLostOrDoubledMessages: _omitted, ...rest } = ci.areas['agent-home']!;
    ci.areas['agent-home'] = rest;

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci,
      production: makePassingProdInput(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(
      result.failures.some(
        (f) => f.area === 'agent-home' && f.code === 'MESSAGE_INTEGRITY_FAILED',
      ),
    ).toBe(true);
    expect(result.report).toContain('agent-home');
    expect(result.report).toContain('messageIntegrity=MISSING');
  });

  it('VT-35 / PBI-019 AC-2: flags "post-deploy 5% bound is not yet verified" and sets postDeployVerified=false when deployInWindow is false', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci: makePassingCiInput(),
      production: makePassingProdInput({
        deployInWindow: false,
        postDeployRecreatedRate: null,
      }),
    });

    expect(result.postDeployVerified).toBe(false);
    expect(result.flags.join('\n')).toContain('post-deploy 5% bound is not yet verified');
    expect(result.report).toContain('post-deploy 5% bound is not yet verified');
  });

  it('VT-35 / PBI-019 AC-2: fails when deployInWindow is true and postDeployRecreatedRate exceeds 5%', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci: makePassingCiInput(),
      production: makePassingProdInput({
        deployInWindow: true,
        postDeployRecreatedRate: 0.062,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.postDeployVerified).toBe(false);
    expect(
      result.failures.some((f) => f.target === 'post_deploy_recreated_rate'),
    ).toBe(true);
  });

  it('VT-36 / PBI-019 AC-3: triggers LocalAgentStore escalation when weeklyRecreatedRate > 2% over a week outside deploys, lists all 6 recreate reasons, and fails any reason above its share limit', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci: makePassingCiInput(),
      production: makePassingProdInput({
        windowDays: 7,
        deployInWindow: false,
        postDeployRecreatedRate: null,
        weeklyRecreatedRate: 0.026,
        recreatedByReason: {
          deploy: 0,
          'folder-change': 4,
          'replica-move': 30,
          'sdk-version': 2,
          'idle-eviction': 10,
          unknown: 4,
        },
        reasonShareLimits: {
          'replica-move': 0.25,
          unknown: 0.1,
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.escalationTriggered).toBe(true);
    expect(result.report).toContain('LocalAgentStore');
    expect(result.flags.join('\n')).toContain('LocalAgentStore');

    for (const reason of HARNESS_RECREATE_REASONS) {
      expect(result.report).toContain(reason);
    }

    expect(
      result.failures.some(
        (f) => f.code === 'RECREATE_REASON_LIMIT_EXCEEDED' && f.target === 'replica-move',
      ),
    ).toBe(true);
    expect(result.report).toMatch(/replica-move[\s\S]*FAIL/);
  });

  it('VT-36 / PBI-019 AC-3: fails production gate when fullMemoryShare < 99% or apexControlledFailureRate > 1%', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();

    const result = evaluateChatHarnessReleaseCheck({
      baseline: loadCheckedInBaseline(),
      ci: makePassingCiInput(),
      production: makePassingProdInput({
        fullMemoryShare: 0.982,
        apexControlledFailureRate: 0.015,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.failures.some((f) => f.target === 'full_memory_share')).toBe(true);
    expect(
      result.failures.some((f) => f.target === 'apex_controlled_failure_rate'),
    ).toBe(true);
  });

  it('VT-37 / PBI-019 (e): fails with exitCode 1 and "MISSING BASELINE" when any of the 12 areas is missing from baseline', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();
    const baseline = loadCheckedInBaseline();
    // Removing calendar-assistant removes the resolved baseline for calendar-work-item
    delete baseline.areas['calendar-assistant'];

    const result = evaluateChatHarnessReleaseCheck({
      baseline,
      ci: makePassingCiInput(),
      production: makePassingProdInput(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(
      result.failures.some(
        (f) => f.area === 'calendar-work-item' && f.code === 'MISSING_BASELINE',
      ),
    ).toBe(true);
    expect(result.report).toMatch(/calendar-work-item[\s\S]*MISSING BASELINE/);
  });

  it('VT-37 / PBI-019 (e): fails with exitCode 1 and "MISSING BASELINE" naming area and target when a required baseline target is absent', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();
    const baseline = loadCheckedInBaseline();
    delete baseline.areas['prd-assistant'].targets['longest_gap'];

    const result = evaluateChatHarnessReleaseCheck({
      baseline,
      ci: makePassingCiInput(),
      production: makePassingProdInput(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(
      result.failures.some(
        (f) =>
          f.area === 'prd-assistant' &&
          f.target === 'longest_silent_gap' &&
          f.code === 'MISSING_BASELINE',
      ),
    ).toBe(true);
    expect(result.report).toMatch(/prd-assistant[\s\S]*longest_silent_gap[\s\S]*MISSING BASELINE/);
  });

  it('BR-007 / PBI-019 NFR: report and outputs never include message, prompt, steer, or summary text', () => {
    const { evaluateChatHarnessReleaseCheck } = loadReleaseCheckModule();
    const baseline = loadCheckedInBaseline() as BaselineDocument & Record<string, unknown>;
    baseline.prompt = 'SECRET_PROMPT_CANARY_111';
    const ci = makePassingCiInput();
    const areaWithCanaries = ci.areas['agent-home'] as CiAreaResult & Record<string, unknown>;
    areaWithCanaries.text = 'SECRET_MESSAGE_CANARY_222';
    areaWithCanaries.steerText = 'SECRET_STEER_CANARY_333';
    areaWithCanaries.summaryText = 'SECRET_SUMMARY_CANARY_444';
    areaWithCanaries.contractPassed = false;
    areaWithCanaries.failedScenarios = ['Contains spaces and SECRET_SCENARIO_PROSE_555'];

    const prod = makePassingProdInput() as ProductionGateInput & Record<string, unknown>;
    prod.summary = 'SECRET_PROD_SUMMARY_666';

    const result = evaluateChatHarnessReleaseCheck({
      baseline,
      ci,
      production: prod,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET_PROMPT_CANARY_111');
    expect(serialized).not.toContain('SECRET_MESSAGE_CANARY_222');
    expect(serialized).not.toContain('SECRET_STEER_CANARY_333');
    expect(serialized).not.toContain('SECRET_SUMMARY_CANARY_444');
    expect(serialized).not.toContain('SECRET_SCENARIO_PROSE_555');
    expect(serialized).not.toContain('SECRET_PROD_SUMMARY_666');
  });

  it('CLI runner supports --baseline, --ci, --prod, and --ci-only flags cleanly', () => {
    const { runReleaseCheckCli } = loadReleaseCheckModule();
    const ciPath = path.join(tempDir, 'ci.json');
    const prodPath = path.join(tempDir, 'prod.json');
    writeFileSync(ciPath, JSON.stringify(makePassingCiInput(), null, 2), 'utf8');
    writeFileSync(prodPath, JSON.stringify(makePassingProdInput(), null, 2), 'utf8');

    const fullResult = runReleaseCheckCli([
      '--baseline',
      CHECKED_IN_BASELINE_PATH,
      '--ci',
      ciPath,
      '--prod',
      prodPath,
    ]);
    expect(fullResult.ok).toBe(true);
    expect(fullResult.exitCode).toBe(0);

    const ciOnlyResult = runReleaseCheckCli([
      '--baseline',
      CHECKED_IN_BASELINE_PATH,
      '--ci',
      ciPath,
      '--ci-only',
    ]);
    expect(ciOnlyResult.ok).toBe(true);
    expect(ciOnlyResult.exitCode).toBe(0);

    const missingProdResult = runReleaseCheckCli([
      '--baseline',
      CHECKED_IN_BASELINE_PATH,
      '--ci',
      ciPath,
    ]);
    expect(missingProdResult.ok).toBe(false);
    expect(missingProdResult.exitCode).toBe(1);
  });
});
