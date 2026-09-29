#!/usr/bin/env node
// End-to-end harness for the non-Home V2 flows against a deployed environment.
// Creates its own throwaway records titled "V2 harness <timestamp>" in the
// target project and drives the same endpoints the UI uses:
//
//   interview turn -> PRD generation -> PRD validation -> (owner approve)
//     -> one design doc + prototypes      [document + visual lanes]
//   ADR turn                              [interactive, agentic]
//   UI Lab generation                     [visual lane]
//
// Auth: reuse an SSO session captured with `npm run test:e2e:auth:capture`.
//
// Usage (from repo root):
//   E2E_BASE_URL=https://app-scrum-dev.azurewebsites.net \
//   node scripts/dev/v2-flow-harness.mjs [--only interview,adr,prd,uilab]
//
// Optional env: HARNESS_PROJECT (default Apex), HARNESS_REPO, HARNESS_BRANCH,
// E2E_STORAGE_STATE (default tests/e2e/.auth/storageState.json).

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE_URL = (process.env.E2E_BASE_URL || '').replace(/\/+$/, '');
const STORAGE_STATE = process.env.E2E_STORAGE_STATE || 'tests/e2e/.auth/storageState.json';
const PROJECT = process.env.HARNESS_PROJECT || 'Apex';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const ONLY = onlyIndex >= 0 ? new Set(args[onlyIndex + 1].split(',')) : null;
const enabled = (name) => !ONLY || ONLY.has(name);

const MIN = 60_000;
const SKILLS = {
  interview: '/.cursor/skills/grill-with-docs/SKILL.md',
  adr: '/.cursor/skills/adr-interview/SKILL.md',
  prd: '/.cursor/skills/to-prd/SKILL.md',
};

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function cookieHeader() {
  if (!BASE_URL) fail('E2E_BASE_URL is required');
  let state;
  try {
    state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8'));
  } catch {
    fail(`cannot read storage state at ${STORAGE_STATE}; run npm run test:e2e:auth:capture`);
  }
  const host = new URL(BASE_URL).hostname;
  const cookies = (state.cookies || []).filter((cookie) => {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
  if (cookies.length === 0) fail(`no cookies for ${host} in ${STORAGE_STATE}`);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

const COOKIE = cookieHeader();

async function api(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { cookie: COOKIE, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (response.status === 302 || response.status === 401) {
    fail(`not authenticated (${response.status}); re-run npm run test:e2e:auth:capture`);
  }
  return response;
}

async function json(path, init) {
  const response = await api(path, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const post = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(read, done, { intervalMs = 5_000, timeoutMs }) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await read();
    if (done(last)) return { value: last, elapsedMs: Date.now() - startedAt };
    await sleep(intervalMs);
  }
  return { value: last, elapsedMs: Date.now() - startedAt, timedOut: true };
}

async function resolveKickoff() {
  let repo = process.env.HARNESS_REPO;
  let branch = process.env.HARNESS_BRANCH;
  let skillSettingsId;
  let skillProvider;
  if (!repo) {
    const summaries = await json(`/api/chat/threads?project=${encodeURIComponent(PROJECT)}&limit=5`);
    const items = Array.isArray(summaries) ? summaries : summaries.threads || summaries.items || [];
    for (const summary of items) {
      const thread = await json(`/api/chat/threads/${summary.id}`).catch(() => null);
      if (thread?.kickoff?.repo) {
        repo = thread.kickoff.repo;
        branch = branch || thread.kickoff.branch;
        skillSettingsId = thread.kickoff.skillSettingsId;
        skillProvider = thread.kickoff.skillProvider;
        break;
      }
    }
  }
  if (!repo) fail('could not infer repo; set HARNESS_REPO');
  // The UI always sends the project's provider; without it the server treats
  // the repository as Azure DevOps and grounding fails for GitHub repos.
  skillProvider = process.env.HARNESS_SKILL_PROVIDER
    || skillProvider
    || (repo.includes('/') ? 'github' : 'ado');
  return {
    project: PROJECT,
    repo,
    branch: branch || 'main',
    skillProvider,
    ...(skillSettingsId ? { skillSettingsId } : {}),
  };
}

function parseSse(buffer, onEvent) {
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary >= 0) {
    const chunk = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const data = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data) {
      try {
        onEvent(JSON.parse(data));
      } catch {
        // keep-alive or non-JSON frame
      }
    }
    boundary = rest.indexOf('\n\n');
  }
  return rest;
}

/** Posts one chat turn and follows the thread SSE until `done` or `error`. */
async function chatTurn(threadId, text, timeoutMs) {
  const result = { timings: {}, toolCalls: 0, finalText: '', error: null, interactiveClass: null };
  const controller = new AbortController();
  const stream = await api(`/api/chat/threads/${threadId}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const startedAt = Date.now();
  const mark = (key) => {
    if (result.timings[key] === undefined) result.timings[key] = Date.now() - startedAt;
  };
  const send = await api(`/api/chat/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ turnId: randomUUID(), text }),
  });
  mark('accepted');
  if (send.status !== 202) {
    controller.abort();
    result.error = `send ${send.status}: ${(await send.text()).slice(0, 300)}`;
    return result;
  }
  const accepted = await send.json();
  result.interactiveClass = accepted.interactiveClass ?? 'legacy';
  const runId = accepted.runId;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = parseSse(buffer, (event) => {
        if (event.runId && runId && event.runId !== runId) return;
        if (event.type === 'token') mark('firstToken');
        if (event.type === 'tool_call' || (event.type === 'tool_status' && event.status === 'running')) {
          result.toolCalls += 1;
        }
        if (event.type === 'message' && event.message?.role === 'agent') {
          result.finalText = event.message.text || '';
          mark('finalMessage');
        }
        if (event.type === 'error') {
          result.error = event.error || 'unknown error';
        }
        if (event.type === 'done') {
          mark('done');
          finished = true;
        }
      });
      if (finished) break;
    }
  } catch {
    if (!finished && !result.error) result.error = `timed out after ${timeoutMs} ms`;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (!finished && !result.error) result.error = 'stream ended without done';
  return result;
}

const report = [];
function record(name, status, detail) {
  const entry = { flow: name, ...detail, result: status };
  report.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}

async function createThread(kickoff, skillPath, extra = {}) {
  const created = await post('/api/chat/threads', {
    kickoff: { ...kickoff, skillPath, ...extra },
    skipAutoKickoff: true,
  });
  return created.threadId;
}

async function runInterviewChain(kickoff, userId) {
  const title = `V2 harness ${STAMP} interview`;
  const threadId = await createThread(kickoff, SKILLS.interview);
  const interview = await post('/api/interviews', {
    project: kickoff.project,
    repo: kickoff.repo,
    title,
    chatThreadId: threadId,
    ...(kickoff.skillSettingsId ? { skillSettingsId: kickoff.skillSettingsId } : {}),
    prdOwnerId: userId,
    testCasesEnabled: false,
    prototypeStageEnabled: false,
  });
  const turn = await chatTurn(
    threadId,
    'Harness check, keep it tiny. Feature: add a "Copy link" button to the ADR detail page header '
      + 'that copies the page URL to the clipboard and shows a short "Link copied" toast. '
      + 'One feature, one PBI, no other scope. Do not ask follow-up questions; summarize the requirements.',
    6 * MIN,
  );
  record('interview-turn', turn.error ? 'FAIL' : 'PASS', {
    interviewId: interview.interviewId,
    threadId,
    interactiveClass: turn.interactiveClass,
    toolCalls: turn.toolCalls,
    timingsMs: turn.timings,
    error: turn.error,
  });
  if (turn.error || !enabled('prd')) return;

  const thread = await json(`/api/chat/threads/${threadId}`);
  const transcript = ['# Interview Transcript', ''];
  for (const message of thread.messages || []) {
    if (message.role === 'user' && message.text !== 'Begin.') transcript.push(`**User:** ${message.text}`, '');
    else if (message.role === 'agent') transcript.push(`**Agent:** ${message.text}`, '');
  }
  const prdThreadId = await createThread(kickoff, SKILLS.prd, { transcript: transcript.join('\n') });
  const prd = await post(`/api/interviews/${interview.interviewId}/prds`, {
    chatThreadId: prdThreadId,
    title,
    kickoffGeneration: true,
  });
  const prdId = prd.prdId;
  const generated = await poll(
    () => json(`/api/interviews/prds/${prdId}`),
    (row) => row && !(row.status === 'generating' && !row.content),
    { timeoutMs: 30 * MIN },
  );
  const prdStatus = generated.value?.status;
  const features = generated.value?.backlogJson?.features?.length ?? null;
  const prdOk = !generated.timedOut && Boolean(generated.value?.content) && prdStatus !== 'generation_failed';
  record('prd-generation', prdOk ? 'PASS' : 'FAIL', {
    prdId,
    status: prdStatus,
    features,
    elapsedMs: generated.elapsedMs,
    timedOut: Boolean(generated.timedOut),
  });
  if (!prdOk) return;

  // Auto validation may already be running; start it only when it is not.
  let current = generated.value;
  if (current.status !== 'validating') {
    await post(`/api/interviews/prds/${prdId}/validation-thread`).catch((error) => {
      record('prd-validation', 'FAIL', { prdId, error: String(error.message || error) });
    });
    await sleep(5_000);
  }
  const validated = await poll(
    () => json(`/api/interviews/prds/${prdId}`),
    (row) => row && row.status !== 'validating',
    { timeoutMs: 20 * MIN },
  );
  current = validated.value;
  const validationOk = !validated.timedOut && ['draft', 'pending_review'].includes(current?.status);
  record('prd-validation', validationOk ? 'PASS' : 'FAIL', {
    prdId,
    status: current?.status,
    elapsedMs: validated.elapsedMs,
    timedOut: Boolean(validated.timedOut),
  });

  await Promise.all([
    runDesignDoc(prdId, current),
    runPrototype(prdId),
  ]);
}

async function runDesignDoc(prdId, prdRow) {
  if (prdRow?.status !== 'pending_review') {
    record('design-doc', 'SKIPPED', {
      prdId,
      reason: `PRD is '${prdRow?.status}', not pending_review, so it cannot be owner-approved`,
    });
    return;
  }
  try {
    await post(`/api/interviews/prds/${prdId}/owner-approve`, { status: 'approved', comment: 'V2 harness' });
    await post(`/api/interviews/prds/${prdId}/design-docs`, {});
    const docs = await poll(
      () => json(`/api/interviews/design-docs?prdId=${encodeURIComponent(prdId)}`),
      (rows) => Array.isArray(rows) && rows.length > 0 && rows.every((doc) => doc.status !== 'generating'),
      { timeoutMs: 30 * MIN },
    );
    const statuses = (docs.value || []).map((doc) => doc.status);
    const ok = !docs.timedOut && statuses.length > 0 && !statuses.includes('generation_failed');
    record('design-doc', ok ? 'PASS' : 'FAIL', {
      prdId,
      statuses,
      elapsedMs: docs.elapsedMs,
      timedOut: Boolean(docs.timedOut),
    });
  } catch (error) {
    record('design-doc', 'FAIL', { prdId, error: String(error.message || error) });
  }
}

async function runPrototype(prdId) {
  try {
    await post(`/api/design-prototypes/prd/${prdId}/generate`);
    const rows = await poll(
      () => json(`/api/design-prototypes/prd/${prdId}`),
      (list) => {
        const items = Array.isArray(list) ? list : list?.prototypes || [];
        return items.length > 0 && items.every((item) => !['generating', 'regenerating'].includes(item.status));
      },
      { timeoutMs: 20 * MIN },
    );
    const items = Array.isArray(rows.value) ? rows.value : rows.value?.prototypes || [];
    const statuses = items.map((item) => item.status);
    const ok = !rows.timedOut && statuses.length > 0 && !statuses.includes('generation_failed');
    record('design-prototype', ok ? 'PASS' : 'FAIL', {
      prdId,
      statuses,
      elapsedMs: rows.elapsedMs,
      timedOut: Boolean(rows.timedOut),
    });
  } catch (error) {
    record('design-prototype', 'FAIL', { prdId, error: String(error.message || error) });
  }
}

async function runAdr(kickoff) {
  try {
    const threadId = await createThread(kickoff, SKILLS.adr);
    const adr = await post('/api/adr', {
      project: kickoff.project,
      repo: kickoff.repo,
      title: `V2 harness ${STAMP} ADR`,
      chatThreadId: threadId,
      ...(kickoff.skillSettingsId ? { skillSettingsId: kickoff.skillSettingsId } : {}),
    });
    const turn = await chatTurn(
      threadId,
      'Harness check, keep it short. Decision to discuss: should chat turn workspaces use a git worktree '
        + 'per thread? Give your first question or recommendation in under 150 words.',
      6 * MIN,
    );
    record('adr-turn', turn.error ? 'FAIL' : 'PASS', {
      adrId: adr.adrId,
      threadId,
      interactiveClass: turn.interactiveClass,
      toolCalls: turn.toolCalls,
      timingsMs: turn.timings,
      error: turn.error,
    });
  } catch (error) {
    record('adr-turn', 'FAIL', { error: String(error.message || error) });
  }
}

async function runUiLab(kickoff) {
  try {
    const created = await post('/api/ui-lab', {
      project: kickoff.project,
      title: `V2 harness ${STAMP} UI Lab`,
      prompt: 'A small card with a title, one line of body text, and a primary "Copy link" button.',
    });
    const id = created.id ?? created.sessionId ?? created.uiLabId;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * MIN);
    let outcome = null;
    let error = null;
    try {
      const stream = await api(`/api/ui-lab/${id}/stream`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = parseSse(buffer, (event) => {
          if (event.type === 'complete') outcome = 'complete';
          if (event.type === 'error') {
            outcome = 'error';
            error = event.error || event.message || 'unknown error';
          }
        });
        if (outcome) break;
      }
    } catch {
      if (!outcome) error = 'timed out or stream closed';
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const row = await json(`/api/ui-lab/${id}`).catch(() => null);
    const ok = outcome === 'complete' || row?.status === 'ready';
    record('ui-lab', ok ? 'PASS' : 'FAIL', {
      id,
      outcome,
      status: row?.status,
      elapsedMs: Date.now() - startedAt,
      error,
    });
  } catch (error) {
    record('ui-lab', 'FAIL', { error: String(error.message || error) });
  }
}

async function main() {
  const kickoff = await resolveKickoff();
  const probeThread = await createThread(kickoff, SKILLS.interview);
  const userId = (await json(`/api/chat/threads/${probeThread}`)).userId;
  await api(`/api/chat/threads/${probeThread}`, { method: 'DELETE' }).catch(() => {});
  console.log(`V2 flow harness → ${BASE_URL} project=${kickoff.project} repo=${kickoff.repo} stamp=${STAMP}`);

  await Promise.all([
    enabled('interview') ? runInterviewChain(kickoff, userId) : null,
    enabled('adr') ? runAdr(kickoff) : null,
    enabled('uilab') ? runUiLab(kickoff) : null,
  ]);

  console.log('\nSummary:');
  for (const entry of report) console.log(`  ${entry.result.padEnd(7)} ${entry.flow}`);
  process.exit(report.some((entry) => entry.result === "FAIL") ? 1 : 0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
