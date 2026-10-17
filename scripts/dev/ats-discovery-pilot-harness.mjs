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
  check('TBI-001 DoD-1', /leadership's vision/i.test(text) && text.indexOf('## Opening') < text.indexOf('## Research and redaction rules'), 'opens with vision before research rules');
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
  check('TBI-002 DoD-1', /full ledger/i.test(text) && /Decision ledger — changed this reply/.test(text), 'visible ledger header on every reply');
  check('TBI-002 DoD-2', /which is authoritative/i.test(text) && /no skip/i.test(text), 'conflict pauses and asks which is authoritative');
  check('TBI-002 DoD-3', text.includes('.ai-pilot/kickoff-transcript.md') && text.includes('## Final Decision Ledger'), 'final ledger is written for PRD generation');
  check('PBI-002 AC-1', /D04 should be confirmed/.test(text), 'leader can correct a misstated row');
  check('PBI-002 AC-3', /never counted as confirmed/.test(text), 'superseded rows stay visible and are not confirmed');
  check('TBI-002 NFR cap', /40 rows/.test(text) && /160 characters/.test(text), 'ledger cap is 40 rows and 160 characters');

  for (const kind of ['Personal', 'Client', 'Commercial', 'Internal']) {
    check(`TBI-003 DoD-0 ${kind}`, text.includes(`${kind}:`), `lists ${kind} identifiers`);
  }
  check('TBI-003 DoD-0 step', /Research status: searching/.test(text), 'prints the redacted query before search');
  check('TBI-003 DoD-1', /source, page, and date/i.test(text), 'source and date on every recorded claim');
  check('TBI-003 DoD-2', /material claim/i.test(text) && /second independent source/i.test(text) && /uncorroborated/.test(text), 'material claim and corroboration defined');
  check('TBI-003 DoD-3', /Pilot review/.test(text) && /Bullhorn/.test(text) && /JobDiva/.test(text), 'benchmark seeds marked for pilot review');
  check('PBI-003 AC-1', /unavailable or returns nothing useful/i.test(text), 'unavailable research labels assumed or unresolved');
  check('PBI-003 AC-3', /no open decision/i.test(text), 'no research when no decision is open');
  check('PBI-004 AC-1', /generalize it/i.test(text), 'uncertain terms are generalized or asked');
  check('PBI-004 AC-3', /decline/i.test(text) && /generic search/i.test(text), 'direct name search is declined');
  check('PBI-005 AC-2', /research interrupted/.test(text), 'interrupted research is labeled');

  for (const heading of ['## Phase 1 Brief', '## Deferred Roadmap', '## Research Notes', '## Final Decision Ledger']) {
    check(`TBI-004 DoD-1 ${heading}`, text.includes(heading), heading);
  }
  check('TBI-004 DoD-0', /Completion rubric: PASS/.test(text) && /Completion rubric: FAIL/.test(text) && /C1\./.test(text) && /C5\./.test(text), 'completion checks C1–C5');
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
  check('TBI-006 DoD-0', ['| 1 |', '| 2 |', '| 3 |', '| 4 |', '| 5 |', '| 6 |'].every((row) => checklist.includes(row)), 'one check per pass condition');
  check('TBI-006 DoD-1', ['S-A', 'S-B', 'S-C', 'S-D'].every((id) => checklist.includes(id)), 'scenarios cover normal, conflict, resume, and seeded identifiers');
  check('TBI-006 DoD-2', /View-only user/.test(checklist), 'checklist includes a view-only permission check');
  check('TBI-006 DoD-3', /Runtime gap/.test(checklist) && /separate PRD/i.test(checklist), 'runtime gaps need a separate PRD');
  check('PBI-008 AC-0', /Passed/.test(checklist) && /Not passed/.test(results), 'results file can record pass or fail');
  check('PBI-008 AC-1', /missing citation/.test(checklist) && /Revise the skill/.test(checklist), 'a failed check names the failure and requires revision');
  check('PBI-008 AC-2', /runtime gap/i.test(checklist) && /not expand this skill/i.test(results), 'runtime gaps stay out of this scope');
  check('PBI-008 AC-3', /did not accept/.test(checklist) && /No score replaces/.test(checklist), 'withheld acceptance fails the pilot');
}

function ledgerRows(text) {
  return text.split('\n').filter((line) => /^D\d+\s+·/.test(line.trim()));
}

function confirmedIds(text) {
  return ledgerRows(text)
    .filter((line) => /·\s+confirmed\s+·/.test(line))
    .map((line) => line.trim().slice(0, 3));
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
  'Decision ledger — changed this reply: D07 — 3 rows',
  'D01 · confirmed · Vision · Replace the current ATS with a smaller workflow · L01 · basis leader',
  'D04 · assumed · Phase 1 workflow · Email intake stays out until tested · L01 · basis research · uncorroborated',
  'D05 · superseded by D12 · Phase 1 workflow',
  'D07 · unresolved · Interview coordination · Leader skipped this area · L06 · basis leader',
].join('\n');

function selfTest() {
  const rows = ledgerRows(FIXTURE_LEDGER);
  check('PBI-002 AC-0', rows.length === 4 && confirmedIds(FIXTURE_LEDGER).join(',') === 'D01', 'new and earlier states stay distinct');
  check('PBI-002 AC-3 fixture', FIXTURE_LEDGER.includes('D05 · superseded by D12') && !confirmedIds(FIXTURE_LEDGER).includes('D05'), 'superseded row is not confirmed');
  check('TBI-002 DoD-4 states', ['confirmed', 'assumed', 'unresolved', 'superseded'].every((s) => FIXTURE_LEDGER.includes(`· ${s}`) || FIXTURE_LEDGER.includes(`· superseded`)), 'fixture covers the four states');

  const longRow = `D02 · confirmed · Topic · ${'word '.repeat(40)} · L02 · basis leader`;
  check('VT-15 row length', longRow.length > 160, 'over-long row is detectable');
  check('VT-15 fixture rows', rows.every((row) => row.length <= 160) && rows.length <= 40, 'fixture ledger is within the cap');

  const badQuery = 'Zephyr Health Staffing Dana Whitfield ProjectHeron $41.37';
  const goodQuery = 'staffing requisition web form common practice';
  check('PBI-004 AC-0 leak', leakHits(badQuery).length >= 3, `seeded query is caught (${leakHits(badQuery).join(',')})`);
  check('PBI-004 AC-0 clean', leakHits(goodQuery).length === 0, 'generic query has no seeded identifier');

  const passageQuery = 'Dana Whitfield at Zephyr Health said the contract pays well';
  check('PBI-004 AC-2', leakHits(passageQuery).length > 0, 'four-word passage run is caught');
  const generalized = 'how staffing firms take requisitions from clients';
  check('PBI-004 AC-2 clean', leakHits(generalized).length === 0, 'generalized passage query is clean');

  const decline = 'I will not search for that client. A public search of a client name can expose them. I can search for staffing agency client submission workflow instead.\n\nDecision ledger — changed this reply: none — 1 rows\nD01 · confirmed · Vision · Smaller workflow · L01 · basis leader\n\nWhich generic search should I run?\n\na. Staffing agency client submission workflow\nb. Requisition intake common practice\nc. Skip — decide later';
  check('PBI-004 AC-3 fixture', /will not search/i.test(decline) && /generic search|search for staffing/i.test(decline) && !decline.includes(SEEDED.client), 'decline explains and offers a generic search');

  const conflict = 'Earlier decision: requisitions enter by web form only. New answer: requisitions also enter by email.\n\nDecision ledger — changed this reply: none — 1 rows\nD05 · confirmed · Phase 1 workflow · Requisitions enter by web form only · L01 · basis leader · [conflict with new answer]\n\nWhich decision is authoritative?\n\na. Keep the earlier decision\nb. Use the new answer\nc. Restate it';
  check('PBI-002 AC-2 fixture', /web form only/.test(conflict) && /also enter by email/.test(conflict) && /authoritative/.test(conflict) && !/Research status: searching/.test(conflict), 'conflict quotes both and does not search');

  const correction = 'Decision ledger — changed this reply: D04 — 1 rows\nD04 · confirmed · Phase 1 workflow · Email intake stays out · L01 · basis leader';
  check('PBI-002 AC-1 fixture', /changed this reply: D04/.test(correction) && /D04 · confirmed/.test(correction), 'correction names D04 and restores confirmed');

  const interrupted = 'D09 · unresolved · Offer · research interrupted · L07 · basis research';
  check('PBI-005 AC-2 fixture', /research interrupted/.test(interrupted) && /unresolved/.test(interrupted), 'interrupted research is unresolved');

  const complete = [
    'Completion rubric: PASS',
    'C1. pass',
    '## Phase 1 Brief',
    'Status: COMPLETE',
    '## Deferred Roadmap',
    'L11 reporting — deferred — revisit after Phase 1 — D20',
    '## Research Notes',
    'Web forms are common. D03. Vendor docs, pricing page, 2025-04. Corroborated.',
    '## Final Decision Ledger',
    'This ledger overrides every earlier ledger in this conversation.',
    'D08 · unresolved · Reporting · Leader skipped · L11 · basis leader',
  ].join('\n');
  check('PBI-006 AC-0 fixture', complete.includes('Completion rubric: PASS') && complete.includes('Status: COMPLETE') && complete.includes('## Research Notes'), 'complete reply has rubric and sections');
  check('PBI-006 AC-2 fixture', complete.includes('D08 · unresolved') && complete.includes('## Deferred Roadmap') && !/D08 · confirmed/.test(complete), 'unresolved item is listed and not confirmed');

  const failFinish = 'Completion rubric: FAIL\nC1. L08 has no decision and no unresolved row.\n\nWhich label should L08 carry?\n\na. Unresolved\nb. Covered by a decision I will type\nc. Skip — decide later';
  check('PBI-006 AC-1 fixture', /Completion rubric: FAIL/.test(failFinish) && /L08/.test(failFinish) && !/Status: COMPLETE/.test(failFinish), 'gap names L08 and does not complete');

  const conflictFinish = 'Completion rubric: FAIL\nC2. Open conflict on requisition intake.\n\nWhich decision is authoritative?\n\na. Keep the earlier decision\nb. Use the new answer\nc. Restate it';
  check('PBI-006 AC-3 fixture', /FAIL/.test(conflictFinish) && /authoritative/.test(conflictFinish) && !/Status: COMPLETE/.test(conflictFinish), 'open conflict refuses a completed brief');

  const oneQuestion = 'Vision recorded.\n\nDecision ledger — changed this reply: D01 — 1 rows\nD01 · confirmed · Vision · Smaller workflow · L01 · basis leader\n\nHow should a requisition enter?\n\na. Web form only\nb. Recruiter enters it\nc. Email and web form\nd. Skip — decide later';
  const parsed = choiceBlocksViaParser(oneQuestion);
  if (parsed.error) {
    check('PBI-001 AC-0 parse', false, parsed.error);
  } else {
    check('PBI-001 AC-0 parse', parsed.choiceCount === 1 && parsed.lastIsChoice, `choice blocks=${parsed.choiceCount} lastIsChoice=${parsed.lastIsChoice}`);
  }

  const researchReply = 'Research status: searching "staffing requisition intake common practice"\nResearch status: done, 2 sources\n\nDecision ledger — changed this reply: D03 — 1 rows\nD03 · confirmed · Phase 1 workflow · Web form intake is common · L01 · basis research · cite: Staffing Industry Analysts, public summary, 2025-06 + American Staffing Association, public note, 2025-03';
  const found = queriesFromReply(researchReply, [{ type: 'tool_call', input: { keys: ['query'] } }]);
  check('PBI-003 AC-0 fixture', leakHits(found.printed.join(' ')).length === 0 && /cite:/.test(researchReply) && /\+ American Staffing Association/.test(researchReply), 'cited corroborated claim uses a generic printed query');
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
