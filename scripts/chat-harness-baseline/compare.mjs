#!/usr/bin/env node
/**
 * PBI-003 (AC-0, AC-1, AC-2, AC-3) — Side-by-side chat timing baseline comparator.
 *
 * Compares `baseline.json` against current measurements (`--current <file>`, or
 * `--baseline` self-check when `--self-check` is passed).
 *
 * Rules:
 * - Missing area or missing required baseline cell prints `MISSING BASELINE` and exits non-zero.
 * - Sample count < MIN_SAMPLES_FOR_P95 (200) prints `LOW SAMPLE` and counts as not passed.
 * - Prints an accessible plain-text side-by-side table (target, baseline, current, delta, status).
 * - Stores nothing and never outputs message text.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_AREA_IDS, DURABLE_ACQUISITION_AREAS, TIMING_TARGETS } from './record.mjs';

export const MIN_SAMPLES_FOR_P95 = 200;

export const BINDING_P95_CEILINGS_MS = {
  send_to_feedback: 200,
  first_token: 8_000,
  longest_gap: 2_000,
  stop: 300,
  reconnect_restored: 2_000,
};

function parseArgs(argv) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let baseline = path.join(dir, 'baseline.json');
  let current = path.join(dir, 'baseline.json');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--baseline' && argv[i + 1]) {
      baseline = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--current' && argv[i + 1]) {
      current = argv[i + 1];
      i += 1;
    }
  }
  return { baseline, current };
}

function pad(value, width) {
  const str = String(value);
  return str.length >= width ? str : `${str}${' '.repeat(width - str.length)}`;
}

function evaluateTimingRow(metric, baseCell, currCell) {
  if (!baseCell || baseCell.status !== 'recorded' || typeof baseCell.p95Ms !== 'number') {
    return {
      target: metric,
      baselineText: 'missing',
      currentText: currCell?.p95Ms != null ? `${currCell.p95Ms} ms` : 'missing',
      deltaText: 'n/a',
      verdict: 'MISSING BASELINE',
      ok: false,
    };
  }
  if (!currCell || currCell.status !== 'recorded' || typeof currCell.p95Ms !== 'number') {
    return {
      target: metric,
      baselineText: `${baseCell.p95Ms} ms`,
      currentText: 'missing',
      deltaText: 'n/a',
      verdict: 'MISSING CURRENT',
      ok: false,
    };
  }
  const delta = Math.round((currCell.p95Ms - baseCell.p95Ms) * 100) / 100;
  const deltaSign = delta > 0 ? `+${delta} ms` : `${delta} ms`;
  if ((currCell.sampleCount ?? 0) < MIN_SAMPLES_FOR_P95 || (baseCell.sampleCount ?? 0) < MIN_SAMPLES_FOR_P95) {
    return {
      target: metric,
      baselineText: `${baseCell.p95Ms} ms (n=${baseCell.sampleCount ?? 0})`,
      currentText: `${currCell.p95Ms} ms (n=${currCell.sampleCount ?? 0})`,
      deltaText: deltaSign,
      verdict: 'LOW SAMPLE',
      ok: false,
    };
  }
  const ceiling = BINDING_P95_CEILINGS_MS[metric];
  const withinTarget = ceiling === undefined ? currCell.p95Ms <= baseCell.p95Ms : currCell.p95Ms <= ceiling;
  return {
    target: metric,
    baselineText: `${baseCell.p95Ms} ms`,
    currentText: `${currCell.p95Ms} ms`,
    deltaText: deltaSign,
    verdict: withinTarget ? 'PASS' : 'REGRESSION',
    ok: withinTarget,
  };
}

function evaluateAcquisitionRow(area, baseCell, currCell) {
  if (!DURABLE_ACQUISITION_AREAS.has(area)) {
    return {
      target: 'acquisition_mode',
      baselineText: 'n/a (in-process)',
      currentText: 'n/a (in-process)',
      deltaText: 'n/a',
      verdict: 'N/A',
      ok: true,
    };
  }
  if (!baseCell || baseCell.status !== 'recorded' || typeof baseCell.warmOrResumedRate !== 'number') {
    return {
      target: 'acquisition_mode',
      baselineText: 'missing',
      currentText: 'n/a',
      deltaText: 'n/a',
      verdict: 'MISSING BASELINE',
      ok: false,
    };
  }
  if (!currCell || currCell.status !== 'recorded' || typeof currCell.warmOrResumedRate !== 'number') {
    return {
      target: 'acquisition_mode',
      baselineText: `${(baseCell.warmOrResumedRate * 100).toFixed(1)}%`,
      currentText: 'missing',
      deltaText: 'n/a',
      verdict: 'MISSING CURRENT',
      ok: false,
    };
  }
  const basePct = `${(baseCell.warmOrResumedRate * 100).toFixed(1)}%`;
  const currPct = `${(currCell.warmOrResumedRate * 100).toFixed(1)}%`;
  const deltaPct = `${((currCell.warmOrResumedRate - baseCell.warmOrResumedRate) * 100).toFixed(1)} pp`;
  if ((currCell.sampleCount ?? 0) < MIN_SAMPLES_FOR_P95 || (baseCell.sampleCount ?? 0) < MIN_SAMPLES_FOR_P95) {
    return {
      target: 'acquisition_mode',
      baselineText: basePct,
      currentText: currPct,
      deltaText: deltaPct,
      verdict: 'LOW SAMPLE',
      ok: false,
    };
  }
  const withinTarget = currCell.warmOrResumedRate >= 0.99;
  return {
    target: 'acquisition_mode',
    baselineText: basePct,
    currentText: currPct,
    deltaText: deltaPct,
    verdict: withinTarget ? 'PASS' : 'REGRESSION',
    ok: withinTarget,
  };
}

export function compareBaselines(baselineDoc, currentDoc) {
  const lines = [];
  let allPassed = true;

  lines.push(
    `Chat Harness Baseline Comparison (SDK baseline=${baselineDoc?.sdkVersion ?? 'unknown'}, minSamples=${MIN_SAMPLES_FOR_P95})`,
  );
  if (baselineDoc?.deployWindowNote) {
    lines.push(`Deploy window note: ${baselineDoc.deployWindowNote}`);
  }
  lines.push('');

  for (const area of CHAT_AREA_IDS) {
    const baseArea = baselineDoc?.areas?.[area];
    const currArea = currentDoc?.areas?.[area];
    if (!baseArea?.targets) {
      allPassed = false;
      lines.push(`=== Area: ${area} — MISSING BASELINE (blocks release check) ===`);
      lines.push('');
      continue;
    }

    lines.push(`=== Area: ${area} ===`);
    lines.push(
      `${pad('Target', 22)} | ${pad('Baseline', 20)} | ${pad('Current', 20)} | ${pad('Delta', 12)} | Status`,
    );
    lines.push('-'.repeat(92));

    for (const metric of TIMING_TARGETS) {
      const row = evaluateTimingRow(
        metric,
        baseArea.targets[metric],
        currArea?.targets?.[metric],
      );
      if (!row.ok) allPassed = false;
      lines.push(
        `${pad(row.target, 22)} | ${pad(row.baselineText, 20)} | ${pad(row.currentText, 20)} | ${pad(row.deltaText, 12)} | ${row.verdict}`,
      );
    }

    const acqRow = evaluateAcquisitionRow(
      area,
      baseArea.targets.acquisition_mode,
      currArea?.targets?.acquisition_mode,
    );
    if (!acqRow.ok) allPassed = false;
    lines.push(
      `${pad(acqRow.target, 22)} | ${pad(acqRow.baselineText, 20)} | ${pad(acqRow.currentText, 20)} | ${pad(acqRow.deltaText, 12)} | ${acqRow.verdict}`,
    );
    lines.push('');
  }

  return { report: `${lines.join('\n')}\n`, ok: allPassed };
}

function main() {
  const { baseline, current } = parseArgs(process.argv.slice(2));
  const baselineDoc = JSON.parse(readFileSync(baseline, 'utf8'));
  const currentDoc = JSON.parse(readFileSync(current, 'utf8'));
  const { report, ok } = compareBaselines(baselineDoc, currentDoc);
  process.stdout.write(report);
  process.exit(ok ? 0 : 1);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
