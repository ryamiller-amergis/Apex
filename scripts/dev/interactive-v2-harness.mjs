#!/usr/bin/env node
// End-to-end harness for durable interactive (V2) chat turns against a deployed
// environment. Drives the same endpoints the Home UI uses: create thread, send a
// turn, consume the SSE stream, and report stage timings with pass/fail.
//
// Auth: reuse an SSO session captured once with `npm run test:e2e:auth:capture`.
//
// Usage (from repo root):
//   E2E_BASE_URL=https://app-scrum-dev.azurewebsites.net \
//   E2E_STORAGE_STATE=tests/e2e/.auth/storageState.json \
//   node scripts/dev/interactive-v2-harness.mjs [--only name] [--model id]
//
// Optional env:
//   HARNESS_PROJECT       project name (default: Apex)
//   HARNESS_REPO          repo name (default: repo of your most recent thread)
//   HARNESS_BRANCH        branch (default: from recent thread or main)
//   HARNESS_MODEL         model id sent with kickoff and turn (default: server default)

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE_URL = (process.env.E2E_BASE_URL || '').replace(/\/+$/, '');
const STORAGE_STATE = process.env.E2E_STORAGE_STATE || 'tests/e2e/.auth/storageState.json';
const PROJECT = process.env.HARNESS_PROJECT || 'Apex';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const ONLY = argValue('--only');
const MODEL = argValue('--model') || process.env.HARNESS_MODEL || undefined;

const SCENARIOS = [
  {
    name: 'home-plain',
    expectClass: 'fast',
    text: 'Reply with exactly the single word: pong',
    expectText: /pong/i,
    firstActivityTargetMs: 10_000,
    completionTargetMs: 30_000,
    timeoutMs: 120_000,
  },
  {
    name: 'home-repo',
    expectClass: undefined,
    text:
      'In two sentences, what does the Apex Agent Home page show? '
      + 'Name one client component file that renders it.',
    expectText: /\.tsx/i,
    firstActivityTargetMs: 10_000,
    completionTargetMs: 90_000,
    timeoutMs: 360_000,
  },
];

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
    headers: {
      cookie: COOKIE,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (response.status === 302 || response.status === 401) {
    fail(`not authenticated (${response.status}); re-run npm run test:e2e:auth:capture`);
  }
  return response;
}

async function resolveKickoff() {
  let repo = process.env.HARNESS_REPO;
  let branch = process.env.HARNESS_BRANCH;
  let skillSettingsId;
  if (!repo) {
    const list = await api(`/api/chat/threads?project=${encodeURIComponent(PROJECT)}&limit=5`);
    const summaries = list.ok ? await list.json() : [];
    const items = Array.isArray(summaries) ? summaries : summaries.threads || summaries.items || [];
    for (const summary of items) {
      const detail = await api(`/api/chat/threads/${summary.id}`);
      if (!detail.ok) continue;
      const thread = await detail.json();
      if (thread?.kickoff?.repo) {
        repo = thread.kickoff.repo;
        branch = branch || thread.kickoff.branch;
        skillSettingsId = thread.kickoff.skillSettingsId;
        break;
      }
    }
  }
  if (!repo) fail('could not infer repo; set HARNESS_REPO');
  return {
    project: PROJECT,
    repo,
    branch: branch || 'main',
    ...(skillSettingsId ? { skillSettingsId } : {}),
    ...(MODEL ? { model: MODEL } : {}),
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
        // Ignore keep-alive or non-JSON frames.
      }
    }
    boundary = rest.indexOf('\n\n');
  }
  return rest;
}

async function runScenario(kickoff, scenario) {
  const result = {
    name: scenario.name,
    interactiveClass: null,
    timings: {},
    toolCalls: 0,
    finalText: '',
    error: null,
  };
  const create = await api('/api/chat/threads', {
    method: 'POST',
    body: JSON.stringify({ kickoff, skipAutoKickoff: true }),
  });
  if (!create.ok) {
    result.error = `create thread ${create.status}: ${await create.text()}`;
    return result;
  }
  const { threadId } = await create.json();
  result.threadId = threadId;

  const controller = new AbortController();
  const stream = await api(`/api/chat/threads/${threadId}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!stream.ok || !stream.body) {
    result.error = `stream ${stream.status}`;
    return result;
  }

  const startedAt = Date.now();
  const mark = (key) => {
    if (result.timings[key] === undefined) result.timings[key] = Date.now() - startedAt;
  };

  const send = await api(`/api/chat/threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      turnId: randomUUID(),
      text: scenario.text,
      ...(MODEL ? { model: MODEL } : {}),
    }),
  });
  mark('accepted');
  if (send.status !== 202) {
    result.error = `send ${send.status}: ${await send.text()}`;
    controller.abort();
    return result;
  }
  const accepted = await send.json();
  result.interactiveClass = accepted.interactiveClass ?? 'legacy';
  result.runId = accepted.runId;

  const timeout = setTimeout(() => controller.abort(), scenario.timeoutMs);
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = parseSse(buffer, (event) => {
        if (event.runId && result.runId && event.runId !== result.runId) return;
        switch (event.type) {
          case 'phase':
            if (event.phase === 'dispatched') mark('dispatched');
            mark('firstActivity');
            break;
          case 'tool_status':
          case 'tool_call':
            result.toolCalls += event.status === 'running' || event.type === 'tool_call' ? 1 : 0;
            mark('firstTool');
            mark('firstActivity');
            break;
          case 'token':
            mark('firstToken');
            mark('firstActivity');
            break;
          case 'message':
            if (event.message?.role === 'agent') {
              result.finalText = event.message.text || '';
              mark('finalMessage');
            }
            break;
          case 'error':
            result.error = event.error || 'unknown error';
            mark('error');
            break;
          case 'done':
            mark('done');
            finished = true;
            break;
          default:
            break;
        }
      });
      if (finished) break;
    }
  } catch (err) {
    if (!finished && !result.error) {
      result.error = controller.signal.aborted
        ? `timed out after ${scenario.timeoutMs} ms`
        : `stream failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  if (!finished && !result.error) result.error = 'stream ended without done';
  return result;
}

function evaluate(result, scenario) {
  const problems = [];
  if (result.error) problems.push(result.error);
  if (scenario.expectClass && result.interactiveClass !== scenario.expectClass) {
    problems.push(`expected ${scenario.expectClass}, got ${result.interactiveClass}`);
  }
  if (!result.error && !scenario.expectText.test(result.finalText)) {
    problems.push('final answer missing expected content');
  }
  const first = result.timings.firstActivity;
  if (first === undefined || first > scenario.firstActivityTargetMs) {
    problems.push(`first activity ${first ?? 'never'} ms > ${scenario.firstActivityTargetMs} ms`);
  }
  const done = result.timings.done;
  if (done === undefined || done > scenario.completionTargetMs) {
    problems.push(`completion ${done ?? 'never'} ms > ${scenario.completionTargetMs} ms`);
  }
  return problems;
}

async function main() {
  const kickoff = await resolveKickoff();
  console.log(`Harness → ${BASE_URL} project=${kickoff.project} repo=${kickoff.repo} model=${kickoff.model ?? '(server default)'}`);
  let failures = 0;
  for (const scenario of SCENARIOS) {
    if (ONLY && scenario.name !== ONLY) continue;
    const result = await runScenario(kickoff, scenario);
    const problems = evaluate(result, scenario);
    const status = problems.length === 0 ? 'PASS' : 'FAIL';
    if (problems.length) failures += 1;
    console.log(JSON.stringify({
      status,
      scenario: result.name,
      threadId: result.threadId,
      runId: result.runId,
      interactiveClass: result.interactiveClass,
      toolCalls: result.toolCalls,
      timingsMs: result.timings,
      problems,
      answerPreview: result.finalText.slice(0, 160),
    }, null, 2));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
