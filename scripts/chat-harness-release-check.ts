#!/usr/bin/env node
/**
 * S11 / PBI-019 — Two-gate Chat Harness release check.
 *
 * Gate 1 (CI + Baseline):
 *   Verifies all 12 `HARNESS_AREA_IDS` pass contract checks, report no lost or
 *   doubled messages, meet every binding P95 timing target (excluding model
 *   thinking time), and match a recorded baseline cell (resolving seed aliases
 *   such as `calendar-work-item` -> `calendar-assistant`).
 *
 * Gate 2 (Production export):
 *   Verifies warm/resumed full-memory share (>= 99%), weekly recreated-turn
 *   rate (<= 1%, with LocalAgentStore escalation > 2% over a week outside
 *   deploys), post-deploy recreated-turn rate (<= 5% when a deploy occurred in
 *   the window, otherwise flags "post-deploy 5% bound is not yet verified"),
 *   Apex-controlled failure rate (<= 1%), and per-reason recreation share
 *   limits across all 6 `HARNESS_RECREATE_REASONS`.
 *
 * Privacy (BR-007 / PBI-019 NFR):
 *   Outputs only area ids, target names, numeric timings/rates/counts,
 *   sanitized scenario ids, and status labels — never message, prompt, steer,
 *   or summary text.
 *
 * Usage:
 *   npx ts-node -P tsconfig.server.json scripts/chat-harness-release-check.ts \
 *     --baseline scripts/chat-harness-baseline/baseline.json \
 *     --ci path/to/ci-results.json \
 *     --prod path/to/prod-export.json
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HARNESS_AREA_IDS,
  HARNESS_RECREATE_REASONS,
  resolveChatAreaId,
  type HarnessAreaId,
  type HarnessRecreateReason,
} from '../src/shared/types/chatHarness';

export const CI_TIMING_THRESHOLDS_MS = {
  send_to_first_feedback: 200,
  apex_overhead_warm: 500,
  first_token_warm: 3_000,
  first_token_new_chat: 8_000,
  progress_step_new_chat: 1_000,
  longest_silent_gap: 2_000,
  stop_ui_halt: 300,
  stop_confirmed: 2_000,
  steer_acknowledged: 500,
  reconnect_restored: 2_000,
  reload_restored: 2_000,
} as const;

export type CiTimingTarget = keyof typeof CI_TIMING_THRESHOLDS_MS;

export const CI_TIMING_TARGETS: readonly CiTimingTarget[] = [
  'send_to_first_feedback',
  'apex_overhead_warm',
  'first_token_warm',
  'first_token_new_chat',
  'progress_step_new_chat',
  'longest_silent_gap',
  'stop_ui_halt',
  'stop_confirmed',
  'steer_acknowledged',
  'reconnect_restored',
  'reload_restored',
] as const;

export type BaselineTimingKey =
  | 'send_to_feedback'
  | 'first_token'
  | 'longest_gap'
  | 'stop'
  | 'reconnect_restored';

export const BASELINE_KEY_FOR_CI_TARGET: Readonly<
  Record<CiTimingTarget, BaselineTimingKey>
> = {
  send_to_first_feedback: 'send_to_feedback',
  apex_overhead_warm: 'first_token',
  first_token_warm: 'first_token',
  first_token_new_chat: 'first_token',
  progress_step_new_chat: 'send_to_feedback',
  longest_silent_gap: 'longest_gap',
  stop_ui_halt: 'stop',
  stop_confirmed: 'stop',
  steer_acknowledged: 'send_to_feedback',
  reconnect_restored: 'reconnect_restored',
  reload_restored: 'reconnect_restored',
};

export const PRODUCTION_THRESHOLDS = {
  minFullMemoryShare: 0.99,
  maxWeeklyRecreatedRate: 0.01,
  weeklyEscalationRecreatedRate: 0.02,
  escalationWindowDays: 7,
  maxPostDeployRecreatedRate: 0.05,
  maxApexControlledFailureRate: 0.01,
} as const;

export const POST_DEPLOY_UNVERIFIED_FLAG =
  'post-deploy 5% bound is not yet verified';

export interface BaselineTimingCell {
  status?: string;
  p95Ms?: number | null;
  sampleCount?: number;
}

export interface BaselineAreaEntry {
  targets?: Record<string, BaselineTimingCell | undefined>;
}

export interface BaselineDocument {
  schemaVersion?: number;
  sdkVersion?: string;
  windowStart?: string;
  windowEnd?: string;
  deployInWindow?: boolean;
  areas?: Record<string, BaselineAreaEntry | undefined>;
}

export interface CiAreaResult {
  contractPassed: boolean;
  failedScenarios?: string[];
  timingsMs: Partial<Record<CiTimingTarget, number>>;
  noLostOrDoubledMessages?: boolean;
}

export interface CiGateInput {
  areas: Partial<Record<HarnessAreaId, CiAreaResult>>;
}

export interface ProductionGateInput {
  windowDays: number;
  deployInWindow: boolean;
  fullMemoryShare: number;
  weeklyRecreatedRate: number;
  postDeployRecreatedRate?: number | null;
  apexControlledFailureRate: number;
  recreatedByReason: Partial<Record<HarnessRecreateReason, number>>;
  reasonShareLimits?: Partial<Record<HarnessRecreateReason, number>>;
}

export type ReleaseCheckMode = 'full' | 'ci-only' | 'prod-only';

export interface ReleaseCheckInput {
  baseline: BaselineDocument;
  ci?: CiGateInput;
  production?: ProductionGateInput;
  mode?: ReleaseCheckMode;
}

export type ReleaseCheckFailureCode =
  | 'MISSING_BASELINE'
  | 'MISSING_CI_AREA'
  | 'CONTRACT_FAILED'
  | 'MESSAGE_INTEGRITY_FAILED'
  | 'TIMING_TARGET_EXCEEDED'
  | 'INVALID_MEASUREMENT'
  | 'MISSING_PRODUCTION_INPUT'
  | 'PRODUCTION_TARGET_FAILED'
  | 'ESCALATION_TRIGGERED'
  | 'RECREATE_REASON_LIMIT_EXCEEDED';

export interface ReleaseCheckFailure {
  gate: 'baseline' | 'ci' | 'production';
  area?: HarnessAreaId;
  target: string;
  code: ReleaseCheckFailureCode;
  message: string;
}

export interface ReleaseCheckResult {
  ok: boolean;
  exitCode: 0 | 1;
  report: string;
  failures: ReleaseCheckFailure[];
  flags: string[];
  escalationTriggered: boolean;
  postDeployVerified: boolean;
}

export interface ParsedCliArgs {
  baselinePath: string;
  ciPath: string | null;
  prodPath: string | null;
  ciOnly: boolean;
  prodOnly: boolean;
}

const DEFAULT_BASELINE_PATH = path.resolve(
  __dirname,
  'chat-harness-baseline',
  'baseline.json',
);

const SAFE_SCENARIO_ID_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const SAFE_SDK_VERSION_PATTERN = /^[a-zA-Z0-9._+-]+$/;

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : `${value}${' '.repeat(width - value.length)}`;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return isNonNegativeFinite(value) && value <= 1;
}

function formatMs(ms: number): string {
  const rounded = Math.round(ms * 100) / 100;
  return `${rounded} ms`;
}

function formatDeltaMs(currentMs: number, baselineMs: number): string {
  const delta = Math.round((currentMs - baselineMs) * 100) / 100;
  return delta > 0 ? `+${delta} ms` : `${delta} ms`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function sanitizeScenarioId(value: unknown): string {
  if (typeof value !== 'string') return '<invalid-scenario-id>';
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 64 ||
    !SAFE_SCENARIO_ID_PATTERN.test(trimmed)
  ) {
    return '<redacted-scenario>';
  }
  return trimmed;
}

function sanitizeSdkVersion(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 32 ||
    !SAFE_SDK_VERSION_PATTERN.test(trimmed)
  ) {
    return 'unknown';
  }
  return trimmed;
}

function resolveBaselineArea(
  baseline: BaselineDocument | undefined,
  area: HarnessAreaId,
): { entry: BaselineAreaEntry | undefined; resolvedKey: string } {
  const areas = baseline?.areas;
  if (!areas || typeof areas !== 'object') {
    return { entry: undefined, resolvedKey: area };
  }
  if (areas[area]) {
    return { entry: areas[area], resolvedKey: area };
  }
  const alias = resolveChatAreaId(area);
  if (alias && areas[alias]) {
    return { entry: areas[alias], resolvedKey: alias };
  }
  return { entry: undefined, resolvedKey: alias ?? area };
}

function resolveBaselineTimingCell(
  areaEntry: BaselineAreaEntry | undefined,
  target: CiTimingTarget,
): { cell: BaselineTimingCell | undefined; keyUsed: string } {
  const targets = areaEntry?.targets;
  if (!targets || typeof targets !== 'object') {
    return { cell: undefined, keyUsed: BASELINE_KEY_FOR_CI_TARGET[target] };
  }
  if (targets[target] !== undefined) {
    return { cell: targets[target], keyUsed: target };
  }
  const mappedKey = BASELINE_KEY_FOR_CI_TARGET[target];
  return { cell: targets[mappedKey], keyUsed: mappedKey };
}

function isRecordedTimingCell(
  cell: BaselineTimingCell | undefined,
): cell is BaselineTimingCell & { p95Ms: number } {
  return Boolean(
    cell && cell.status === 'recorded' && isNonNegativeFinite(cell.p95Ms),
  );
}

export function evaluateChatHarnessReleaseCheck(
  input: ReleaseCheckInput,
): ReleaseCheckResult {
  const mode: ReleaseCheckMode = input.mode ?? 'full';
  const failures: ReleaseCheckFailure[] = [];
  const flags: string[] = [];
  const lines: string[] = [];
  let escalationTriggered = false;
  let postDeployVerified = false;

  const sdkVersion = sanitizeSdkVersion(input.baseline?.sdkVersion);
  lines.push(
    `Chat Harness Release Check (mode=${mode}, areas=${HARNESS_AREA_IDS.length}, baselineSdk=${sdkVersion})`,
  );
  lines.push('');

  // ── Gate 1: Baseline + CI Contract & Timing Targets ───────────────────────
  if (mode !== 'prod-only') {
    lines.push('## Gate 1: CI Contract & Timing Targets (12 Harness Areas)');
    lines.push('');

    for (const area of HARNESS_AREA_IDS) {
      const { entry: baseArea, resolvedKey } = resolveBaselineArea(
        input.baseline,
        area,
      );
      const ciArea = input.ci?.areas?.[area];

      if (!baseArea?.targets) {
        failures.push({
          gate: 'baseline',
          area,
          target: 'area',
          code: 'MISSING_BASELINE',
          message: `Area ${area} (baseline key ${resolvedKey}): MISSING BASELINE`,
        });
      }

      if (!ciArea) {
        failures.push({
          gate: 'ci',
          area,
          target: 'contract',
          code: 'MISSING_CI_AREA',
          message: `Area ${area}: missing CI gate results`,
        });
      } else {
        if (ciArea.contractPassed !== true) {
          const scenarios = Array.isArray(ciArea.failedScenarios)
            ? ciArea.failedScenarios.map(sanitizeScenarioId)
            : [];
          const scenarioSuffix =
            scenarios.length > 0 ? ` (scenarios: ${scenarios.join(', ')})` : '';
          failures.push({
            gate: 'ci',
            area,
            target: 'contract',
            code: 'CONTRACT_FAILED',
            message: `Area ${area}: contract suite failed${scenarioSuffix}`,
          });
        }
        if (ciArea.noLostOrDoubledMessages !== true) {
          failures.push({
            gate: 'ci',
            area,
            target: 'no_lost_or_doubled_messages',
            code: 'MESSAGE_INTEGRITY_FAILED',
            message:
              ciArea.noLostOrDoubledMessages === false
                ? `Area ${area}: lost or doubled messages detected`
                : `Area ${area}: missing noLostOrDoubledMessages verification`,
          });
        }
      }

      const aliasNote =
        resolvedKey !== area ? ` (baseline=${resolvedKey})` : '';
      if (!baseArea?.targets) {
        lines.push(
          `=== Area: ${area}${aliasNote} — MISSING BASELINE (blocks release) ===`,
        );
      } else {
        const contractStatus = !ciArea
          ? 'MISSING'
          : ciArea.contractPassed
            ? 'PASS'
            : 'FAIL';
        const integrityStatus = !ciArea
          ? 'MISSING'
          : ciArea.noLostOrDoubledMessages === true
            ? 'PASS'
            : ciArea.noLostOrDoubledMessages === false
              ? 'FAIL'
              : 'MISSING';
        lines.push(
          `=== Area: ${area}${aliasNote} | contract=${contractStatus} | messageIntegrity=${integrityStatus} ===`,
        );
      }

      if (ciArea && ciArea.contractPassed !== true) {
        const scenarios = Array.isArray(ciArea.failedScenarios)
          ? ciArea.failedScenarios.map(sanitizeScenarioId)
          : [];
        if (scenarios.length > 0) {
          lines.push(`Failed scenarios: ${scenarios.join(', ')}`);
        }
      }

      lines.push(
        `${pad('Target', 24)} | ${pad('Baseline', 14)} | ${pad('Current', 14)} | ${pad('Delta', 12)} | ${pad('Threshold', 12)} | Status`,
      );
      lines.push('-'.repeat(100));

      for (const target of CI_TIMING_TARGETS) {
        const thresholdMs = CI_TIMING_THRESHOLDS_MS[target];
        const thresholdText = `<= ${thresholdMs} ms`;
        const { cell: baseCell, keyUsed } = resolveBaselineTimingCell(
          baseArea,
          target,
        );
        const currentMs = ciArea?.timingsMs?.[target];
        const hasValidBaseline = isRecordedTimingCell(baseCell);

        let baselineText = 'missing';
        let currentText = 'not measured';
        let deltaText = 'n/a';
        let status = 'PASS';

        if (currentMs !== undefined) {
          currentText = isNonNegativeFinite(currentMs)
            ? formatMs(currentMs)
            : 'invalid';
        }

        if (!hasValidBaseline) {
          status = 'MISSING BASELINE';
          if (baseArea?.targets) {
            failures.push({
              gate: 'baseline',
              area,
              target,
              code: 'MISSING_BASELINE',
              message: `Area ${area} target ${target} (baseline key ${keyUsed}): MISSING BASELINE`,
            });
          }
        } else {
          baselineText = formatMs(baseCell.p95Ms);
          if (currentMs === undefined) {
            status = 'N/A';
          } else if (!isNonNegativeFinite(currentMs)) {
            status = 'FAIL';
            failures.push({
              gate: 'ci',
              area,
              target,
              code: 'INVALID_MEASUREMENT',
              message: `Area ${area} target ${target}: invalid timing measurement`,
            });
          } else {
            deltaText = formatDeltaMs(currentMs, baseCell.p95Ms);
            if (currentMs > thresholdMs) {
              status = 'FAIL';
              failures.push({
                gate: 'ci',
                area,
                target,
                code: 'TIMING_TARGET_EXCEEDED',
                message: `Area ${area} target ${target}: ${formatMs(currentMs)} exceeds ${thresholdText}`,
              });
            } else {
              status = 'PASS';
            }
          }
        }

        lines.push(
          `${pad(target, 24)} | ${pad(baselineText, 14)} | ${pad(currentText, 14)} | ${pad(deltaText, 12)} | ${pad(thresholdText, 12)} | ${status}`,
        );
      }
      lines.push('');
    }
  }

  // ── Gate 2: Production Export Targets ─────────────────────────────────────
  if (mode !== 'ci-only') {
    lines.push('## Gate 2: Production Export Targets');
    lines.push('');

    const prod = input.production;
    if (!prod) {
      failures.push({
        gate: 'production',
        target: 'production_input',
        code: 'MISSING_PRODUCTION_INPUT',
        message: 'Production gate input is required unless running with --ci-only',
      });
      lines.push('Production export: MISSING (required unless --ci-only)');
      lines.push('');
    } else {
      const validWindowDays =
        typeof prod.windowDays === 'number' &&
        Number.isFinite(prod.windowDays) &&
        prod.windowDays > 0;
      const windowDaysText = validWindowDays ? `${prod.windowDays}d` : 'invalid';
      if (!validWindowDays) {
        failures.push({
          gate: 'production',
          target: 'window_days',
          code: 'INVALID_MEASUREMENT',
          message: 'Production windowDays must be a positive number',
        });
      }

      lines.push(
        `Window: ${windowDaysText} | deployInWindow=${String(Boolean(prod.deployInWindow))}`,
      );
      lines.push(
        `${pad('Metric', 30)} | ${pad('Measured', 14)} | ${pad('Threshold', 16)} | Status`,
      );
      lines.push('-'.repeat(76));

      // 1. Full memory share (>= 99%)
      const fullMemValid = isRate(prod.fullMemoryShare);
      const fullMemOk =
        fullMemValid &&
        prod.fullMemoryShare >= PRODUCTION_THRESHOLDS.minFullMemoryShare;
      if (!fullMemOk) {
        failures.push({
          gate: 'production',
          target: 'full_memory_share',
          code: 'PRODUCTION_TARGET_FAILED',
          message: `full_memory_share ${fullMemValid ? formatPct(prod.fullMemoryShare) : 'invalid'} is below >= 99.00%`,
        });
      }
      lines.push(
        `${pad('full_memory_share', 30)} | ${pad(fullMemValid ? formatPct(prod.fullMemoryShare) : 'invalid', 14)} | ${pad('>= 99.00%', 16)} | ${fullMemOk ? 'PASS' : 'FAIL'}`,
      );

      // 2. Weekly recreated rate (<= 1%; escalation > 2% over a week outside deploys)
      const weeklyValid = isRate(prod.weeklyRecreatedRate);
      const weeklyOk =
        weeklyValid &&
        prod.weeklyRecreatedRate <=
          PRODUCTION_THRESHOLDS.maxWeeklyRecreatedRate;
      if (!weeklyOk) {
        failures.push({
          gate: 'production',
          target: 'weekly_recreated_rate',
          code: 'PRODUCTION_TARGET_FAILED',
          message: `weekly_recreated_rate ${weeklyValid ? formatPct(prod.weeklyRecreatedRate) : 'invalid'} exceeds <= 1.00%`,
        });
      }
      if (
        validWindowDays &&
        prod.windowDays >= PRODUCTION_THRESHOLDS.escalationWindowDays &&
        weeklyValid &&
        prod.weeklyRecreatedRate >
          PRODUCTION_THRESHOLDS.weeklyEscalationRecreatedRate
      ) {
        escalationTriggered = true;
        const escalationFlag =
          `LocalAgentStore escalation triggered: weekly_recreated_rate ${formatPct(prod.weeklyRecreatedRate)} exceeds 2.00% over ${prod.windowDays}d outside deploys`;
        flags.push(escalationFlag);
        failures.push({
          gate: 'production',
          target: 'weekly_recreated_rate',
          code: 'ESCALATION_TRIGGERED',
          message: escalationFlag,
        });
      }
      lines.push(
        `${pad('weekly_recreated_rate', 30)} | ${pad(weeklyValid ? formatPct(prod.weeklyRecreatedRate) : 'invalid', 14)} | ${pad('<= 1.00%', 16)} | ${weeklyOk ? 'PASS' : escalationTriggered ? 'FAIL (ESCALATE)' : 'FAIL'}`,
      );

      // 3. Post-deploy recreated rate (<= 5% when deployInWindow === true)
      if (!prod.deployInWindow) {
        postDeployVerified = false;
        flags.push(POST_DEPLOY_UNVERIFIED_FLAG);
        lines.push(
          `${pad('post_deploy_recreated_rate', 30)} | ${pad('no deploy', 14)} | ${pad('<= 5.00%', 16)} | UNVERIFIED`,
        );
      } else {
        const postDeployValid = isRate(prod.postDeployRecreatedRate);
        const postDeployOk =
          postDeployValid &&
          prod.postDeployRecreatedRate <=
            PRODUCTION_THRESHOLDS.maxPostDeployRecreatedRate;
        postDeployVerified = postDeployOk;
        if (!postDeployOk) {
          failures.push({
            gate: 'production',
            target: 'post_deploy_recreated_rate',
            code: 'PRODUCTION_TARGET_FAILED',
            message: `post_deploy_recreated_rate ${postDeployValid ? formatPct(prod.postDeployRecreatedRate) : 'missing'} exceeds <= 5.00%`,
          });
        }
        lines.push(
          `${pad('post_deploy_recreated_rate', 30)} | ${pad(postDeployValid ? formatPct(prod.postDeployRecreatedRate) : 'missing', 14)} | ${pad('<= 5.00%', 16)} | ${postDeployOk ? 'PASS' : 'FAIL'}`,
        );
      }

      // 4. Apex-controlled failure rate (<= 1%)
      const failureRateValid = isRate(prod.apexControlledFailureRate);
      const failureRateOk =
        failureRateValid &&
        prod.apexControlledFailureRate <=
          PRODUCTION_THRESHOLDS.maxApexControlledFailureRate;
      if (!failureRateOk) {
        failures.push({
          gate: 'production',
          target: 'apex_controlled_failure_rate',
          code: 'PRODUCTION_TARGET_FAILED',
          message: `apex_controlled_failure_rate ${failureRateValid ? formatPct(prod.apexControlledFailureRate) : 'invalid'} exceeds <= 1.00%`,
        });
      }
      lines.push(
        `${pad('apex_controlled_failure_rate', 30)} | ${pad(failureRateValid ? formatPct(prod.apexControlledFailureRate) : 'invalid', 14)} | ${pad('<= 1.00%', 16)} | ${failureRateOk ? 'PASS' : 'FAIL'}`,
      );
      lines.push('');

      // 5. Recreated turns by reason (all 6 HARNESS_RECREATE_REASONS)
      lines.push('### Recreated Turns by Reason');
      lines.push(
        `${pad('Reason', 18)} | ${pad('Value', 12)} | ${pad('Share', 10)} | ${pad('Limit', 12)} | Status`,
      );
      lines.push('-'.repeat(70));

      const rawValues: Record<HarnessRecreateReason, number> = {
        deploy: 0,
        'folder-change': 0,
        'replica-move': 0,
        'sdk-version': 0,
        'idle-eviction': 0,
        unknown: 0,
      };
      let totalRaw = 0;
      let hasAnyCountAboveOne = false;

      for (const reason of HARNESS_RECREATE_REASONS) {
        const val = prod.recreatedByReason?.[reason];
        if (val === undefined) {
          rawValues[reason] = 0;
        } else if (!isNonNegativeFinite(val)) {
          rawValues[reason] = 0;
          failures.push({
            gate: 'production',
            target: reason,
            code: 'INVALID_MEASUREMENT',
            message: `Recreated-turn value for reason ${reason} is invalid`,
          });
        } else {
          rawValues[reason] = val;
          totalRaw += val;
          if (val > 1) hasAnyCountAboveOne = true;
        }
      }

      const treatedAsCounts = hasAnyCountAboveOne || totalRaw > 1;

      for (const reason of HARNESS_RECREATE_REASONS) {
        const raw = rawValues[reason];
        const share =
          totalRaw === 0 ? 0 : treatedAsCounts ? raw / totalRaw : raw;
        const limit = prod.reasonShareLimits?.[reason];
        let limitText = 'none';
        let status = 'PASS';

        if (limit !== undefined) {
          if (!isRate(limit)) {
            limitText = 'invalid';
            status = 'FAIL';
            failures.push({
              gate: 'production',
              target: reason,
              code: 'INVALID_MEASUREMENT',
              message: `Share limit for recreate reason ${reason} is invalid`,
            });
          } else {
            limitText = `<= ${formatPct(limit)}`;
            if (share > limit) {
              status = 'FAIL';
              failures.push({
                gate: 'production',
                target: reason,
                code: 'RECREATE_REASON_LIMIT_EXCEEDED',
                message: `Recreate reason ${reason}: share ${formatPct(share)} exceeds limit ${limitText}`,
              });
            }
          }
        }

        const valueText = treatedAsCounts ? String(raw) : formatPct(raw);
        lines.push(
          `${pad(reason, 18)} | ${pad(valueText, 12)} | ${pad(formatPct(share), 10)} | ${pad(limitText, 12)} | ${status}`,
        );
      }
      lines.push('');
    }
  }

  // ── Flags & Final Verdict ─────────────────────────────────────────────────
  const ok = failures.length === 0;
  const exitCode: 0 | 1 = ok ? 0 : 1;

  if (flags.length > 0) {
    lines.push('## Flags');
    for (const flag of flags) {
      lines.push(`- ${flag}`);
    }
    lines.push('');
  }

  if (failures.length > 0) {
    lines.push('## Failures');
    for (const failure of failures) {
      lines.push(`- [${failure.gate}:${failure.code}] ${failure.message}`);
    }
    lines.push('');
  }

  lines.push(
    `Result: ${ok ? 'PASS' : 'FAIL'} (exitCode=${exitCode}, failures=${failures.length}, escalationTriggered=${escalationTriggered}, postDeployVerified=${postDeployVerified})`,
  );

  return {
    ok,
    exitCode,
    report: `${lines.join('\n')}\n`,
    failures,
    flags,
    escalationTriggered,
    postDeployVerified,
  };
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let baselinePath = DEFAULT_BASELINE_PATH;
  let ciPath: string | null = null;
  let prodPath: string | null = null;
  let ciOnly = false;
  let prodOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline' && argv[i + 1]) {
      baselinePath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--ci' && argv[i + 1]) {
      ciPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--prod' && argv[i + 1]) {
      prodPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--ci-only') {
      ciOnly = true;
    } else if (arg === '--prod-only') {
      prodOnly = true;
    }
  }

  return { baselinePath, ciPath, prodPath, ciOnly, prodOnly };
}

export function runReleaseCheckCli(argv: string[]): ReleaseCheckResult {
  const args = parseCliArgs(argv);
  const baseline = JSON.parse(
    readFileSync(args.baselinePath, 'utf8'),
  ) as BaselineDocument;
  const ci = args.ciPath
    ? (JSON.parse(readFileSync(args.ciPath, 'utf8')) as CiGateInput)
    : undefined;
  const production = args.prodPath
    ? (JSON.parse(readFileSync(args.prodPath, 'utf8')) as ProductionGateInput)
    : undefined;

  const mode: ReleaseCheckMode = args.ciOnly
    ? 'ci-only'
    : args.prodOnly
      ? 'prod-only'
      : 'full';

  return evaluateChatHarnessReleaseCheck({
    baseline,
    ci,
    production,
    mode,
  });
}

if (require.main === module) {
  try {
    const result = runReleaseCheckCli(process.argv.slice(2));
    process.stdout.write(result.report);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(
      `Chat harness release check error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
