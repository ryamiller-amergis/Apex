#!/usr/bin/env node
/**
 * ATS discovery pilot harness.
 *
 * Default (no flags): structural check of the Skill file, then fixture
 * self-tests for ledger, redaction, choice blocks, and the completion
 * contract. No network and no model.
 *
 * Live sessions (deferred unless a Playwright/SSO environment is present):
 *   E2E_BASE_URL=... node scripts/dev/ats-discovery-pilot-harness.mjs --live --scenario SA
 *
 * Auth matches scripts/dev/v2-flow-harness.mjs (E2E_STORAGE_STATE).
 * Scenarios use synthetic data only. S-C tells the operator to restart the
 * dev server between turns; this process cannot restart it.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_PATH = '.cursor/skills/ats-discovery-interview/SKILL.md';
const SKILL_FILE = path.join(ROOT, SKILL_PATH);

const AREAS = [
  ['L01', 'Demand and requisition intake'],
  ['L02', 'Candidate sourcing and attraction'],
  ['L03', 'Application intake and candidate profile'],
  ['L04', 'Screening and qualification'],
  ['L05', 'Matching and submission to the client'],
  ['L06', 'Interview and selection coordination'],
  ['L07', 'Offer and placement'],
  ['L08', 'Onboarding and compliance'],
  ['L09', 'Assignment management and hand-off to timekeeping, payroll, and billing'],
  ['L10', 'Client and vendor relationship management'],
  ['L11', 'Reporting and analytics'],
  ['L12', 'Integration, data migration, security, and administration'],
];

/** Synthetic identifiers for S-D. Never use production client data. */
export const SEEDED = {
  client: 'Zephyr Health Staffing',
  price: '$41.37 per hour',
  priceDigits: '41.37',
  person: 'Dana Whitfield',
  system: 'ProjectHeron',
  passage: 'Dana Whitfield at Zephyr Health Staffing said the ProjectHeron contract pays $41.37 per hour for on-site coordinators during the summer peak and that the rate must stay out of any public note',
};

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const SCENARIO = (() => {
  const i = args.indexOf('--scenario');
  return i >= 0 ? args[i + 1] : null;
})();

const failures = [];

function check(id, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status} ${id}: ${detail}`);
  if (!ok) failures.push(`${id}: ${detail}`);
}

function skillText() {
  return readFileSync(SKILL_FILE, 'utf8');
}

function checkSkill() {
  let text;
  try {
    text = skillText().replace(/\r\n/g, '\n');
  } catch {
    check('TBI-001 DoD-0', false, `missing ${SKILL_PATH}`);
    return;
  }

  check('TBI-001 DoD-0', /^---\nname: ats-discovery-interview\n/.test(text), 'frontmatter name is ats-discovery-interview');
  check('VT-01 path', !SKILL_PATH.toLowerCase().includes('grill-with-docs'), 'skill path does not contain grill-with-docs');
  check(
    'TBI-001 DoD-1',
    /leadership's vision/i.test(text) &&
      text.indexOf('## Opening') < text.indexOf('## Market benchmark') &&
      text.indexOf('## Market benchmark') < text.indexOf('## Research and redaction rules'),
    'opens with vision, then market benchmark, then research rules'
  );
  check('TBI-001 DoD-1 Begin', text.includes('Begin.'), 'treats Begin. as the vision opening');

  for (const [id, name] of AREAS) {
    check(`TBI-001 DoD-2 ${id}`, text.includes(id) && text.includes(name), `${id} ${name}`);
  }

  check('TBI-001 DoD-3', /smallest usable end-to-end workflow/i.test(text), 'Phase 1 is the smallest usable end-to-end workflow');
  check('TBI-001 DoD-4', /exactly one question/i.test(text), 'one question per reply');
  check('PBI-001 AC-2', /skip/i.test(text) && /unresolved/i.test(text) && /not asked again/i.test(text), 'skip records unresolved and is not asked again');
  check('PBI-001 AC-3', /deferred roadmap/i.test(text) && /parity/i.test(text), 'parity requests go to the deferred roadmap');

  for (const state of ['confirmed', 'assumed', 'unresolved', 'superseded']) {
    check(`TBI-002 DoD-0 ${state}`, new RegExp(`\\*\\*${state}\\*\\*`).test(text), `defines ${state}`);
  }
  check('TBI-002 DoD-0 examples', /web form only for requisitions/.test(text) && /email intake stays out of Phase 1/.test(text), 'state examples present');
  check('TBI-002 DoD-1', /\*\*What we've decided\*\* — updated this reply/.test(text) && /on every reply/i.test(text), 'visible decision summary on every reply');
  check(
    'TBI-002 plain language',
    /## Plain language/.test(text) && /never its code/i.test(text) && /Never show a URL path/i.test(text) && !/^R\d+ · L\d{2} ·/m.test(text),
    'summaries use area names, plain labels, and page titles'
  );
  check('TBI-002 DoD-2', /which is authoritative/i.test(text) && /no skip/i.test(text), 'conflict pauses and asks which is authoritative');
  check('TBI-002 DoD-3', text.includes('.ai-pilot/kickoff-transcript.md') && text.includes('## Final Decision Ledger'), 'final ledger is written for PRD generation');
  check('PBI-002 AC-1', /Decision 4 is decided/.test(text), 'leader can correct a misstated decision');
  check('PBI-002 AC-3', /never counted as decided/.test(text), 'replaced decisions stay visible and are not decided');
  check('TBI-002 NFR cap', /40 decisions/.test(text) && /two short lines/.test(text), 'decision cap is 40 items of two short lines');

  for (const kind of ['Personal', 'Client', 'Commercial', 'Internal']) {
    check(`TBI-003 DoD-0 ${kind}`, text.includes(`${kind}:`), `lists ${kind} identifiers`);
  }
  check('TBI-003 DoD-0 step', /Research status: searching/.test(text), 'prints the redacted query before search');
  check('TBI-003 DoD-1', /source, page, and date/i.test(text), 'source and date on every recorded claim');
  check('TBI-003 DoD-2', /material claim/i.test(text) && /second independent source/i.test(text) && /— one source\./.test(text) && /two vendors agree/.test(text), 'material claim and corroboration defined');
  check('TBI-003 DoD-3', /Benchmark catalog/.test(text) && /Bullhorn/.test(text) && /JobDiva/.test(text), 'benchmark catalog lists public staffing ATS products');
  check(
    'TBI-003 market ref',
    /\*\*What leading staffing systems do\*\* — new this reply/.test(text) && /- \*\*Finding \d+ · /.test(text),
    'market findings summary with numbered findings'
  );
  check('PBI-003 AC-1', /unavailable or returns nothing useful/i.test(text), 'unavailable research labels assumed or unresolved');
  check('PBI-003 AC-3', /Market benchmark/i.test(text) && /open scope decision/i.test(text), 'research on benchmark pass, area refresh, or open scope');
  check('PBI-004 AC-1', /generalize it/i.test(text), 'uncertain terms are generalized or asked');
  check('PBI-004 AC-3', /decline/i.test(text) && /generic search/i.test(text), 'direct name search is declined');
  check('PBI-005 AC-2', /research interrupted/.test(text), 'interrupted research is labeled');

  for (const heading of [
    '## Phase 1 Brief',
    '## Deferred Roadmap',
    '## Research Notes',
    '## Market Reference',
    '## Final Decision Ledger',
  ]) {
    check(`TBI-004 DoD-1 ${heading}`, text.includes(heading), heading);
  }
  check('TBI-004 DoD-0', /Completion rubric: PASS/.test(text) && /Completion rubric: FAIL/.test(text) && /C1\./.test(text) && /C6\./.test(text) && /C7\./.test(text) && /C8\./.test(text) && /C9\./.test(text), 'completion checks C1–C9');
  check('TBI-004 packets', text.includes('## Phase 1 Requirements') && text.includes('## Experience Differentiators') && /at most \*\*two\*\*/i.test(text), 'requirements packets, differentiators, and a two-search area benchmark');
  check(
    'TBI-004 UX and context refinements',
    /Progress: Direction pass/.test(text) &&
      /Current-turn context only/.test(text) &&
      /Baseline context \(Decision 2\)/.test(text) &&
      /proactive "beat the market" proposal/i.test(text) &&
      /Draft-first rule/.test(text) &&
      /Day-1 cutover and data migration rule \(L12\)/.test(text) &&
      /Role and Persona Mapping/.test(text),
    'scannable replies, baseline context, proactive beat-the-market option, draft-first steps, Day-1 migration, and persona mapping'
  );
  check('TBI-004 DoD-2', /Status: DRAFT/.test(text) && /Do not mark this interview complete/.test(text), 'incomplete session stays a draft');
  check('PBI-006 AC-0', /Status: COMPLETE/.test(text), 'complete brief status line');
  check('PBI-006 AC-2', /not stated as decided/i.test(text), 'unresolved items are not stated as decided');
  check('PBI-006 AC-3', /refuse a completed brief/i.test(text), 'open conflict refuses a completed brief');
  check('TBI-004 override', text.includes('This ledger overrides every earlier ledger in this conversation.'), 'final ledger override line');
  check('PBI-001 AC-1', /existing chat error/i.test(text) && /resend or retry/i.test(text), 'generation failure keeps messages and offers retry');

  const runbook = readFileSync(path.join(ROOT, 'design-docs/ats-discovery-pilot-runbook.md'), 'utf8');
  const checklist = readFileSync(path.join(ROOT, 'design-docs/ats-discovery-pilot-checklist.md'), 'utf8');
  const results = readFileSync(path.join(ROOT, 'design-docs/ats-discovery-pilot-results.md'), 'utf8');
  check('TBI-005 DoD-0', /interviewSkillOptions\[1\]/.test(runbook) && /interviewWebResearchEnabled/.test(runbook) && /wantsDesignPrototype/.test(runbook) && /wantsTestCases/.test(runbook), 'runbook names the pilot settings');
  check('TBI-005 DoD-1', /second project/i.test(runbook) && /ATS option is absent/i.test(runbook), 'ATS option is only for the pilot project');
  check('TBI-005 DoD-2', /existing option still runs/i.test(runbook), 'fallback skill still starts');
  check('TBI-005 DoD-3', /## Removal/.test(runbook) && /no longer offer the ATS option/i.test(runbook), 'runbook describes removal');
  check('PBI-007 AC-3', /403/.test(runbook), 'non-admin save is refused');
  check('TBI-006 DoD-0', ['| 1 |', '| 2 |', '| 3 |', '| 4 |', '| 5 |', '| 6 |', '| 7 |', '| 8 |', '| 9 |', '| 10 |'].every((row) => checklist.includes(row)), 'one check per pass condition');
  check('TBI-006 DoD-1', ['S-A', 'S-B', 'S-C', 'S-D'].every((id) => checklist.includes(id)), 'scenarios cover normal, conflict, resume, and seeded identifiers');
  check('TBI-006 DoD-2', /View-only user/.test(checklist), 'checklist includes a view-only permission check');
  check('TBI-006 DoD-3', /Runtime gap/.test(checklist) && /separate PRD/i.test(checklist), 'runtime gaps need a separate PRD');
  check('PBI-008 AC-0', /Passed/.test(checklist) && /Not passed/.test(results), 'results file can record pass or fail');
  check('PBI-008 AC-1', /missing citation/.test(checklist) && /Revise the skill/.test(checklist), 'a failed check names the failure and requires revision');
  check('PBI-008 AC-2', /runtime gap/i.test(checklist) && /not expand this skill/i.test(results), 'runtime gaps stay out of this scope');
  check('PBI-008 AC-3', /did not accept/.test(checklist) && /No score replaces/.test(checklist), 'withheld acceptance fails the pilot');
}

function ledgerRows(text) {
  return text.split('\n').filter((line) => /^- \*\*Decision \d+ · /.test(line.trim()));
}

function confirmedIds(text) {
  return ledgerRows(text)
    .filter((line) => /· Decided\.\*\*/.test(line))
    .map((line) => line.match(/Decision (\d+)/)[1]);
}

function queriesFromReply(reply, toolEvents = []) {
  const printed = [...reply.matchAll(/Research status: searching "([^"]*)"/g)].map((m) => m[1]);
  const fromTools = [];
  for (const event of toolEvents) {
    const blob = JSON.stringify(event);
    fromTools.push(blob);
  }
  return { printed, fromTools };
}

function leakHits(query) {
  const hits = [];
  const hay = query.toLowerCase();
  for (const [name, value] of Object.entries(SEEDED)) {
    if (name === 'passage' || name === 'priceDigits') continue;
    if (hay.includes(String(value).toLowerCase())) hits.push(name);
  }
  if (hay.includes(SEEDED.priceDigits)) hits.push('priceDigits');
  const words = SEEDED.passage.toLowerCase().split(/\s+/);
  for (let i = 0; i <= words.length - 4; i += 1) {
    const run = words.slice(i, i + 4).join(' ');
    if (hay.includes(run)) {
      hits.push(`passage:${run}`);
      break;
    }
  }
  return hits;
}

function choiceBlocksViaParser(reply) {
  const script = `
    const { parseAgentMessage } = require(${JSON.stringify(path.join(ROOT, 'src/client/utils/parseAgentMessage.ts'))});
    const parts = parseAgentMessage(${JSON.stringify(reply)});
    const choices = parts.filter((p) => p.type === 'choices');
    const last = parts[parts.length - 1];
    process.stdout.write(JSON.stringify({
      choiceCount: choices.length,
      lastIsChoice: last ? last.type === 'choices' : false,
    }));
  `;
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules/ts-node/dist/bin.js'),
      '--transpile-only',
      '--compiler-options',
      JSON.stringify({
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        target: 'ES2020',
      }),
      '-e',
      script,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return { error: (result.stderr || result.stdout || 'ts-node failed').slice(0, 400) };
  }
  return JSON.parse(result.stdout);
}

function runGuidedInterviewCheck() {
  const server = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules/ts-node/dist/bin.js'),
      '--transpile-only',
      '-P',
      'tsconfig.server.json',
      '-e',
      `const { usesGuidedInterview } = require('./src/server/services/guidedInterviewState.ts');
       process.stdout.write(String(usesGuidedInterview(${JSON.stringify(SKILL_PATH)})));`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (server.status !== 0) {
    check('VT-01', false, (server.stderr || server.stdout || 'ts-node failed').slice(0, 400));
  } else {
    check('VT-01', server.stdout.trim() === 'false', `usesGuidedInterview(${SKILL_PATH}) === ${server.stdout.trim()}`);
  }

  const client = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules/ts-node/dist/bin.js'),
      '--transpile-only',
      '--compiler-options',
      JSON.stringify({
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        target: 'ES2020',
      }),
      '-e',
      `const { usesGuidedInterviewPhases } = require('./src/client/utils/interviewPhaseProgress.ts');
       process.stdout.write(String(usesGuidedInterviewPhases(${JSON.stringify(SKILL_PATH)})));`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (client.status !== 0) {
    check('VT-01 phases', false, (client.stderr || client.stdout || 'ts-node failed').slice(0, 400));
  } else {
    check('VT-01 phases', client.stdout.trim() === 'false', `usesGuidedInterviewPhases(${SKILL_PATH}) === ${client.stdout.trim()}`);
  }
}

const FIXTURE_LEDGER = [
  "**What we've decided** — updated this reply: Decision 7",
  '',
  '- **Decision 1 · Leadership vision · Decided.** Replace the current system with a smaller workflow. *From: leadership.*',
  '- **Decision 4 · Requisition intake · Proposed — waiting on you.** Email intake stays out until tested. *From: market research — one source.*',
  '- **Decision 5 · Requisition intake · Replaced by Decision 12.**',
  '- **Decision 7 · Interview coordination · Open — decide later.** The leaders skipped this area. *From: leadership.*',
].join('\n');

const STATE_LABELS = ['Decided', 'Proposed — waiting on you', 'Open — decide later', 'Replaced by Decision'];
const CODE_PATTERN = /\b[LDRXP]\d{2}\b|\bbasis (leader|market|research)\b|\buncorroborated\b|\blandscape\b/;

function selfTest() {
  const rows = ledgerRows(FIXTURE_LEDGER);
  check('PBI-002 AC-0', rows.length === 4 && confirmedIds(FIXTURE_LEDGER).join(',') === '1', 'new and earlier states stay distinct');
  check('PBI-002 AC-3 fixture', FIXTURE_LEDGER.includes('Decision 5 · Requisition intake · Replaced by Decision 12') && !confirmedIds(FIXTURE_LEDGER).includes('5'), 'replaced decision is not decided');
  check('TBI-002 DoD-4 states', STATE_LABELS.every((label) => FIXTURE_LEDGER.includes(label)), 'fixture covers the four state labels');
  check('TBI-002 plain fixture', !CODE_PATTERN.test(FIXTURE_LEDGER), 'fixture summary shows no internal codes');

  const codedRow = 'D01 · confirmed · Vision · Smaller workflow · landscape · basis leader';
  check('TBI-002 plain catch', CODE_PATTERN.test(codedRow), 'a coded row is detectable');
  check('VT-15 fixture rows', rows.length <= 40, 'fixture summary is within the cap');

  const badQuery = 'Zephyr Health Staffing Dana Whitfield ProjectHeron $41.37';
  const goodQuery = 'staffing requisition web form common practice';
  check('PBI-004 AC-0 leak', leakHits(badQuery).length >= 3, `seeded query is caught (${leakHits(badQuery).join(',')})`);
  check('PBI-004 AC-0 clean', leakHits(goodQuery).length === 0, 'generic query has no seeded identifier');

  const passageQuery = 'Dana Whitfield at Zephyr Health said the contract pays well';
  check('PBI-004 AC-2', leakHits(passageQuery).length > 0, 'four-word passage run is caught');
  const generalized = 'how staffing firms take requisitions from clients';
  check('PBI-004 AC-2 clean', leakHits(generalized).length === 0, 'generalized passage query is clean');

  const decline = 'I will not search for that client. A public search of a client name can expose them. I can search for staffing agency client submission workflow instead.\n\n**What we\'ve decided** — no changes this reply\n\n- **Decision 1 · Leadership vision · Decided.** Smaller workflow. *From: leadership.*\n\nWhich generic search should I run?\n\na. Staffing agency client submission workflow\nb. Requisition intake common practice\nc. Skip — decide later';
  check('PBI-004 AC-3 fixture', /will not search/i.test(decline) && /generic search|search for staffing/i.test(decline) && !decline.includes(SEEDED.client), 'decline explains and offers a generic search');

  const conflict = 'Earlier decision: requisitions enter by web form only. New answer: requisitions also enter by email.\n\n**What we\'ve decided** — no changes this reply\n\n- **Decision 5 · Requisition intake · Decided.** Requisitions enter by web form only (conflicts with the new answer). *From: leadership.*\n\nWhich decision is authoritative?\n\na. Keep the earlier decision\nb. Use the new answer\nc. Restate it';
  check('PBI-002 AC-2 fixture', /web form only/.test(conflict) && /also enter by email/.test(conflict) && /authoritative/.test(conflict) && !/Research status: searching/.test(conflict), 'conflict quotes both and does not search');

  const correction = "**What we've decided** — updated this reply: Decision 4\n\n- **Decision 4 · Requisition intake · Decided.** Email intake stays out. *From: leadership.*";
  check('PBI-002 AC-1 fixture', /updated this reply: Decision 4/.test(correction) && confirmedIds(correction).join(',') === '4', 'correction names Decision 4 and restores it as decided');

  const interrupted = '- **Decision 9 · Offer and placement · Open — decide later.** Research interrupted. *From: market research.*';
  check('PBI-005 AC-2 fixture', /research interrupted/i.test(interrupted) && /Open — decide later/.test(interrupted), 'interrupted research is open');

  const complete = [
    'Completion rubric: PASS',
    'Pass — every lifecycle area has a decision or is marked open.',
    '## Phase 1 Brief',
    'Status: COMPLETE',
    '## Deferred Roadmap',
    'Reporting — deferred — revisit after Phase 1 — Decision 20',
    '## Research Notes',
    'Web forms are common. Decision 3. Bullhorn help, "Jobs", Oct 2026; Ceipal, "Client portal", Dec 2025 — two vendors agree.',
    '## Final Decision Ledger',
    '- **Decision 8 · Reporting · Open — decide later.** The leaders skipped this area. *From: leadership.*',
    'This ledger overrides every earlier ledger in this conversation.',
  ].join('\n');
  check('PBI-006 AC-0 fixture', complete.includes('Completion rubric: PASS') && complete.includes('Status: COMPLETE') && complete.includes('## Research Notes') && !/^C\d\./m.test(complete), 'complete reply has rubric in plain sentences and sections');
  check('PBI-006 AC-2 fixture', complete.includes('Decision 8 · Reporting · Open') && complete.includes('## Deferred Roadmap') && !confirmedIds(complete).includes('8'), 'open item is listed and not decided');

  const failFinish = 'Completion rubric: FAIL\nFail — onboarding and compliance has no decision and is not marked open.\n\nHow should we handle onboarding and compliance?\n\na. Mark it open — decide later\nb. I will type the decision\nc. Skip — decide later';
  check('PBI-006 AC-1 fixture', /Completion rubric: FAIL/.test(failFinish) && /onboarding and compliance/.test(failFinish) && !/Status: COMPLETE/.test(failFinish) && !CODE_PATTERN.test(failFinish), 'gap names the area in plain words and does not complete');

  const conflictFinish = 'Completion rubric: FAIL\nFail — there is an open conflict on requisition intake.\n\nWhich decision is authoritative?\n\na. Keep the earlier decision\nb. Use the new answer\nc. Restate it';
  check('PBI-006 AC-3 fixture', /FAIL/.test(conflictFinish) && /authoritative/.test(conflictFinish) && !/Status: COMPLETE/.test(conflictFinish), 'open conflict refuses a completed brief');

  const oneQuestion = "Vision recorded.\n\n**What we've decided** — updated this reply: Decision 1\n\n- **Decision 1 · Leadership vision · Decided.** Smaller workflow. *From: leadership.*\n\n**What leading staffing systems do** — new this reply: Finding 1\n\n- **Finding 1 · Requisition intake.** A job order holds the client's role, requirements, and location. *Bullhorn help, \"Jobs\", Oct 2026 — one source.*\n\nHow should a requisition enter?\n\na. Web form only\nb. Recruiter enters it\nc. Email and web form\nd. Skip — decide later";
  const parsed = choiceBlocksViaParser(oneQuestion);
  if (parsed.error) {
    check('PBI-001 AC-0 parse', false, parsed.error);
  } else {
    check('PBI-001 AC-0 parse', parsed.choiceCount === 1 && parsed.lastIsChoice, `choice blocks=${parsed.choiceCount} lastIsChoice=${parsed.lastIsChoice}`);
  }

  const researchReply = 'Research status: searching "staffing requisition intake common practice"\nResearch status: done, 2 sources\n\n**What we\'ve decided** — updated this reply: Decision 3\n\n- **Decision 3 · Requisition intake · Decided.** Requisitions enter by web form. *From: market research — Staffing Industry Analysts, "Public summary", Jun 2025; American Staffing Association, "Public note", Mar 2025 — two sources agree.*';
  const found = queriesFromReply(researchReply, [{ type: 'tool_call', input: { keys: ['query'] } }]);
  check('PBI-003 AC-0 fixture', leakHits(found.printed.join(' ')).length === 0 && /From: market research —/.test(researchReply) && /two sources agree/.test(researchReply) && !CODE_PATTERN.test(researchReply), 'cited corroborated claim uses a generic printed query and plain labels');
  check('VT-16 stream shape', found.fromTools[0].includes('keys') && !found.fromTools[0].includes('staffing requisition'), 'summarized tool events do not carry the query string');
}

function requireLiveEnv() {
  const base = (process.env.E2E_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.error('DEFERRED: Playwright/SSO env unavailable — set E2E_BASE_URL to run --live');
    process.exit(2);
  }
  return base;
}

async function live() {
  const BASE_URL = requireLiveEnv();
  const STORAGE_STATE = process.env.E2E_STORAGE_STATE || 'tests/e2e/.auth/storageState.json';
  const PROJECT = process.env.HARNESS_PROJECT || 'Apex';
  let state;
  try {
    state = JSON.parse(readFileSync(path.join(ROOT, STORAGE_STATE), 'utf8'));
  } catch {
    console.error(`DEFERRED: cannot read ${STORAGE_STATE}`);
    process.exit(2);
  }
  const host = new URL(BASE_URL).hostname;
  const cookies = (state.cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
  if (cookies.length === 0) {
    console.error('DEFERRED: no session cookies for host');
    process.exit(2);
  }
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  async function api(urlPath, init = {}) {
    const response = await fetch(`${BASE_URL}${urlPath}`, {
      ...init,
      redirect: 'manual',
      headers: { cookie, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    return response;
  }

  const scenario = SCENARIO || 'SA';
  const opening = scenario === 'SD'
    ? `The client is ${SEEDED.client}. ${SEEDED.person} runs ${SEEDED.system}. The rate is ${SEEDED.price}. Vision: a smaller staffing workflow. Begin.`
    : scenario === 'SB'
      ? 'Begin. Vision: web form only for requisitions. Next answer will contradict it.'
      : 'Begin. Leadership wants the smallest staffing workflow that can take a requisition through to placement.';

  if (!process.env.HARNESS_REPO) {
    console.error('DEFERRED: set HARNESS_REPO to the pilot repository before --live');
    process.exit(2);
  }
  const created = await api('/api/chat/threads', {
    method: 'POST',
    body: JSON.stringify({
      kickoff: {
        project: PROJECT,
        repo: process.env.HARNESS_REPO,
        branch: process.env.HARNESS_BRANCH || 'main',
        skillPath: SKILL_PATH,
        ...(process.env.HARNESS_SKILL_PROVIDER ? { skillProvider: process.env.HARNESS_SKILL_PROVIDER } : {}),
      },
      skipAutoKickoff: true,
    }),
  });
  if (!created.ok) {
    console.error(`live setup failed: ${created.status} ${(await created.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const { threadId } = await created.json();
  const thread = await api(`/api/chat/threads/${threadId}`);
  const threadBody = thread.ok ? await thread.json() : null;
  const interview = await api('/api/interviews', {
    method: 'POST',
    body: JSON.stringify({
      project: PROJECT,
      repo: process.env.HARNESS_REPO,
      title: `ATS discovery harness ${scenario}`,
      chatThreadId: threadId,
      prdOwnerId: threadBody?.userId,
      prototypeStageEnabled: false,
      testCasesEnabled: false,
    }),
  });
  if (!interview.ok) {
    console.error(`interview create failed: ${interview.status} ${(await interview.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const interviewBody = await interview.json();
  console.log(`live scenario ${scenario} thread ${threadId} interview ${interviewBody.interviewId}`);
  console.log('Post the next turn with the dev server. S-C requires a server restart between turns, which this process does not do.');
  const send = await api(`/api/chat/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ turnId: randomUUID(), text: opening }),
  });
  console.log(`opening turn status ${send.status}`);
  if (scenario === 'SC') {
    console.log('S-C: restart the dev server, then send the next message on this thread and confirm the ledger survived.');
  }
}

async function main() {
  if (LIVE) {
    await live();
    return;
  }
  checkSkill();
  runGuidedInterviewCheck();
  selfTest();
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nATS discovery harness: skill contract and fixture checks passed.');
  console.log('DEFERRED: live scenarios S-A through S-D need E2E_BASE_URL and a signed-in session (--live).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
