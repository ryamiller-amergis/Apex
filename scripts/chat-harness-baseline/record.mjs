#!/usr/bin/env node
/**
 * TBI-004 / PBI-003 — Old-path chat timing baseline recorder.
 *
 * Reads an Application Insights query export (`--input <file>`) or queries
 * Application Insights directly when `APPINSIGHTS_APP_ID` + `APPINSIGHTS_API_KEY`
 * are set, and writes `scripts/chat-harness-baseline/baseline.json` (or `--output`).
 *
 * Security NFR (PBI-003 AC-3): stores only canonical area ids, numeric P95 / rates,
 * sample counts, window metadata, and status labels — never message or prompt text.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHAT_AREA_IDS = [
  'agent-home',
  'interview',
  'adr',
  'prd-assistant',
  'design-doc-assistant',
  'ask-apex',
  'calendar-assistant',
  'qa-lab',
  'ui-lab',
  'brainstorm',
  'cab-release',
  'build-intake',
  'standup-participant',
];

export const TIMING_TARGETS = [
  'send_to_feedback',
  'first_token',
  'longest_gap',
  'stop',
  'reconnect_restored',
];

export const DURABLE_ACQUISITION_AREAS = new Set([
  'agent-home',
  'interview',
  'adr',
  'prd-assistant',
  'design-doc-assistant',
  'brainstorm',
  'cab-release',
  'build-intake',
]);

function parseArgs(argv) {
  let input = null;
  let output = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'baseline.json',
  );
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--input' && argv[i + 1]) {
      input = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--output' && argv[i + 1]) {
      output = argv[i + 1];
      i += 1;
    }
  }
  return { input, output };
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Number(value)
    : null;
}

function normalizeTimingCell(cell) {
  if (!cell || typeof cell !== 'object') {
    return { status: 'missing', p95Ms: null, sampleCount: 0 };
  }
  const p95Ms = nonNegativeNumber(cell.p95Ms);
  const sampleCount = Math.floor(nonNegativeNumber(cell.sampleCount) ?? 0);
  if (p95Ms === null) {
    return { status: 'missing', p95Ms: null, sampleCount };
  }
  return {
    status: 'recorded',
    p95Ms,
    sampleCount,
  };
}

function normalizeAcquisitionCell(area, cell) {
  if (!DURABLE_ACQUISITION_AREAS.has(area)) {
    return {
      status: 'not applicable: no acquisition ladder',
      warmOrResumedRate: null,
      recreatedRate: null,
      sampleCount: 0,
    };
  }
  if (!cell || typeof cell !== 'object') {
    return {
      status: 'missing',
      warmOrResumedRate: null,
      recreatedRate: null,
      sampleCount: 0,
    };
  }
  const warmOrResumedRate = nonNegativeNumber(cell.warmOrResumedRate);
  const recreatedRate = nonNegativeNumber(cell.recreatedRate);
  const sampleCount = Math.floor(nonNegativeNumber(cell.sampleCount) ?? 0);
  if (warmOrResumedRate === null || recreatedRate === null) {
    return {
      status: 'missing',
      warmOrResumedRate: null,
      recreatedRate: null,
      sampleCount,
    };
  }
  return {
    status: 'recorded',
    warmOrResumedRate,
    recreatedRate,
    sampleCount,
  };
}

async function queryApplicationInsights() {
  const appId = process.env.APPINSIGHTS_APP_ID?.trim();
  const apiKey = process.env.APPINSIGHTS_API_KEY?.trim();
  if (!appId || !apiKey) {
    throw new Error(
      'Provide --input <fixture.json> or set APPINSIGHTS_APP_ID and APPINSIGHTS_API_KEY.',
    );
  }
  const kql = [
    'customEvents',
    '| where timestamp > ago(7d)',
    '| where name startswith "chat.timing."',
    '| extend area = tostring(customDimensions.area), durationMs = todouble(customDimensions.durationMs)',
    '| summarize p95Ms = percentile(durationMs, 95), sampleCount = count() by area, name',
  ].join('\n');

  const url = `https://api.applicationinsights.io/v1/apps/${encodeURIComponent(appId)}/query`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ query: kql }),
  });
  if (!response.ok) {
    throw new Error(`Application Insights query failed (${response.status})`);
  }
  const payload = await response.json();
  const rows = payload?.tables?.[0]?.rows ?? [];
  const areas = {};
  for (const [area, eventName, p95Ms, sampleCount] of rows) {
    if (typeof area !== 'string' || typeof eventName !== 'string') continue;
    const metric = eventName.replace(/^chat\.timing\./, '');
    areas[area] ??= {};
    areas[area][metric] = { p95Ms, sampleCount };
  }
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  return {
    sdkVersion: '1.4.0',
    windowStart: weekAgo.toISOString(),
    windowEnd: now.toISOString(),
    deployInWindow: false,
    deployWindowNote:
      'Queried from Application Insights; confirm deploy marker separately if no deploy occurred in window.',
    areas,
  };
}

export function buildBaselineDocument(source) {
  const sdkVersion =
    typeof source?.sdkVersion === 'string' && source.sdkVersion.trim()
      ? source.sdkVersion.trim()
      : '1.4.0';
  const windowStart =
    typeof source?.windowStart === 'string' && source.windowStart.trim()
      ? source.windowStart.trim()
      : new Date(0).toISOString();
  const windowEnd =
    typeof source?.windowEnd === 'string' && source.windowEnd.trim()
      ? source.windowEnd.trim()
      : new Date(0).toISOString();
  const deployInWindow = Boolean(source?.deployInWindow);
  const deployWindowNote =
    typeof source?.deployWindowNote === 'string' && source.deployWindowNote.trim()
      ? source.deployWindowNote.trim().slice(0, 240)
      : deployInWindow
        ? 'Recording window includes at least one deploy.'
        : 'No deploy occurred during this recording window; post-deploy recreated-turn bound remains unverified.';

  const rawAreas = source?.areas && typeof source.areas === 'object' ? source.areas : {};
  const areas = {};

  for (const area of CHAT_AREA_IDS) {
    const areaInput = rawAreas[area] ?? {};
    const targets = {};
    for (const metric of TIMING_TARGETS) {
      targets[metric] = normalizeTimingCell(areaInput[metric]);
    }
    targets.acquisition_mode = normalizeAcquisitionCell(
      area,
      areaInput.acquisition_mode,
    );
    areas[area] = { targets };
  }

  return {
    schemaVersion: 1,
    sdkVersion,
    windowStart,
    windowEnd,
    deployInWindow,
    deployWindowNote,
    areas,
  };
}

async function main() {
  const { input, output } = parseArgs(process.argv.slice(2));
  const rawSource = input
    ? JSON.parse(readFileSync(input, 'utf8'))
    : await queryApplicationInsights();
  const document = buildBaselineDocument(rawSource);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote chat harness baseline for ${CHAT_AREA_IDS.length} areas to ${output}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
