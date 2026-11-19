/**
 * VT-13 — PBI-014 (AC-0..3):
 * Reload mid-turn, reconnect replay, and expired-session (401) transcript clearing
 * on the shared chat harness runtime.
 */
import net from 'node:net';
import type { Page, WebSocketRoute } from '@playwright/test';
import { test, expect, E2E_PROJECT, PERSONA_OIDS } from '../support/fixtures';
import {
  stubAdoProjects,
  suppressBetaAnnouncement,
  suppressSseStreams,
} from '../support/api-stubs';
import type {
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../../../src/shared/types/chatHarness';
import type { HarnessTimingRecord } from '../../../src/client/chatHarness/types';

const RUN_ID = '50000000-0000-4000-8000-000000000013';

function isLoopbackPortReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function initHarnessPage(page: Page): Promise<void> {
  await suppressSseStreams(page);
  await suppressBetaAnnouncement(page);
  await stubAdoProjects(page);
  await page.addInitScript((project: string) => {
    (
      window as unknown as { __APEX_CHAT_TIMINGS__?: unknown[] }
    ).__APEX_CHAT_TIMINGS__ = [];
    window.localStorage.setItem('selectedProject', project);
    window.localStorage.setItem('selectedAreaPath', project);
  }, E2E_PROJECT);
}

async function stubHomeThreadShell(
  page: Page,
  threadId: string,
  status: 'idle' | 'running' = 'running',
): Promise<void> {
  await page.route(`**/api/chat/threads/${threadId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: threadId,
        userId: PERSONA_OIDS.developer,
        kickoff: {
          project: E2E_PROJECT,
          repo: 'AI-Pilot',
          branch: 'main',
          model: 'auto',
        },
        messages: [],
        status,
        activeRunId: status === 'running' ? RUN_ID : null,
        workspaceDir: `/tmp/${threadId}`,
        flagged: false,
        createdAt: '2026-11-19T10:00:00.000Z',
        lastActivityAt: '2026-11-19T10:00:00.000Z',
      }),
    });
  });
}

function makeThreadState(
  overrides: Partial<HarnessThreadState> = {},
): HarnessThreadState {
  return {
    threadStatus: 'running',
    activeRunId: RUN_ID,
    phase: 'running',
    harnessArea: 'agent-home',
    pendingCommands: [],
    latestSummary: null,
    canWrite: true,
    ...overrides,
  };
}

async function readTimings(page: Page): Promise<HarnessTimingRecord[]> {
  return page.evaluate(() => {
    const raw = (
      window as unknown as { __APEX_CHAT_TIMINGS__?: HarnessTimingRecord[] }
    ).__APEX_CHAT_TIMINGS__;
    return Array.isArray(raw) ? raw : [];
  });
}

test.describe('Chat harness reload, reconnect, and session expiry (VT-13 / PBI-014)', () => {
  test('VT-13 AC-0/AC-1: reloads mid-turn, restores snapshot within 2s, and resumes stream with zero duplicates', async ({
    page,
    loginAsPersona,
  }) => {
    const ipv4Ready = await isLoopbackPortReachable('127.0.0.1', 3000);
    // DEFERRED: Playwright env unavailable — skip cleanly when no local E2E server is listening on 127.0.0.1:3000.
    test.skip(!ipv4Ready, '// DEFERRED: Playwright env unavailable');
    test.skip(
      typeof page.routeWebSocket !== 'function',
      '// DEFERRED: Playwright env unavailable',
    );

    const threadId = '11111111-1111-4111-8111-111111111101';
    const userPrompt = 'Summarize the rollout checklist for release 2026.19.';
    const partialText = 'Checklist item 1: verify database migrations. ';
    const continuedText = 'Checklist item 2: confirm telemetry dashboards.';
    const finalReply = `${partialText}${continuedText}`;

    await initHarnessPage(page);
    await stubHomeThreadShell(page, threadId, 'running');

    let snapshotCount = 0;
    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        snapshotCount += 1;
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-user-1',
              role: 'user',
              text: userPrompt,
              ts: '2026-11-19T10:00:01.000Z',
            },
          ],
          state: makeThreadState(),
          latestSummary: null,
          canWrite: true,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot),
        });
      },
    );

    let wsOpenCount = 0;
    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        wsOpenCount += 1;
        const attempt = wsOpenCount;
        ws.send(JSON.stringify({ type: 'state', state: makeThreadState() }));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-reload-1',
            data: {
              type: 'thinking',
              seq: 1,
              text: 'Reviewing rollout checklist',
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-reload-2',
            data: {
              type: 'token',
              runId: RUN_ID,
              streamOffset: 0,
              text: partialText,
            },
          }),
        );

        if (attempt >= 2) {
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-reload-3',
              data: {
                type: 'token',
                runId: RUN_ID,
                streamOffset: partialText.length,
                text: continuedText,
              },
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-reload-4',
              data: {
                type: 'message',
                message: {
                  id: 'msg-agent-1',
                  role: 'agent',
                  text: finalReply,
                  ts: '2026-11-19T10:00:05.000Z',
                },
              },
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-reload-5',
              data: {
                type: 'done',
                runId: RUN_ID,
                semanticStatus: 'completed',
              },
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'state',
              state: makeThreadState({
                threadStatus: 'idle',
                activeRunId: null,
                phase: 'idle',
              }),
            }),
          );
        }
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByTestId('chat-agent-harness-panel')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(userPrompt)).toHaveCount(1);
    await expect(page.getByText(partialText.trim())).toBeVisible();

    // Reload mid-turn and verify snapshot restoration + stream resumption.
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('chat-agent-harness-panel')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(finalReply)).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(page.getByText(userPrompt)).toHaveCount(1);
    expect(snapshotCount).toBeGreaterThanOrEqual(2);

    const timings = await readTimings(page);
    const reloadRecord = timings.find(
      (entry) =>
        entry.metric === 'reload_restored' && entry.threadId === threadId,
    );
    expect(reloadRecord).toBeDefined();
    expect(reloadRecord?.status).toBe('ok');
    expect(reloadRecord?.durationMs ?? Infinity).toBeLessThanOrEqual(2_000);
  });

  test('VT-13 AC-2: dropped connection shows Reconnecting then Restored and replays missed events', async ({
    page,
    loginAsPersona,
  }) => {
    const ipv4Ready = await isLoopbackPortReachable('127.0.0.1', 3000);
    // DEFERRED: Playwright env unavailable — skip cleanly when no local E2E server is listening on 127.0.0.1:3000.
    test.skip(!ipv4Ready, '// DEFERRED: Playwright env unavailable');
    test.skip(
      typeof page.routeWebSocket !== 'function',
      '// DEFERRED: Playwright env unavailable',
    );

    const threadId = '11111111-1111-4111-8111-111111111102';
    const replayedReply = 'Recovered final answer after WebSocket replay.';

    await initHarnessPage(page);
    await stubHomeThreadShell(page, threadId, 'running');

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-user-reconnect',
              role: 'user',
              text: 'Check cluster status.',
              ts: '2026-11-19T10:05:00.000Z',
            },
          ],
          state: makeThreadState(),
          latestSummary: null,
          canWrite: true,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot),
        });
      },
    );

    const firstSocketRef: { current: WebSocketRoute | null } = { current: null };
    let wsAttempts = 0;
    let reconnectLastEventId: string | null = null;

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        wsAttempts += 1;
        if (wsAttempts === 1) {
          firstSocketRef.current = ws;
          ws.send(JSON.stringify({ type: 'state', state: makeThreadState() }));
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-conn-1',
              data: {
                type: 'tool_status',
                callId: 'call-cluster-1',
                toolName: 'read_file',
                status: 'running',
                args: { target: 'cluster-health.json' },
              },
            }),
          );
          return;
        }

        const parsedUrl = new URL(ws.url());
        reconnectLastEventId = parsedUrl.searchParams.get('lastEventId');

        ws.send(JSON.stringify({ type: 'state', state: makeThreadState() }));
        // Duplicate durable event id to prove idempotent replay deduplication.
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-conn-1',
            data: {
              type: 'tool_status',
              callId: 'call-cluster-1',
              toolName: 'read_file',
              status: 'running',
              args: { target: 'cluster-health.json' },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-conn-2',
            data: {
              type: 'tool_status',
              callId: 'call-cluster-1',
              toolName: 'read_file',
              status: 'completed',
              args: { target: 'cluster-health.json' },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-conn-3',
            data: {
              type: 'message',
              message: {
                id: 'msg-agent-replayed',
                role: 'agent',
                text: replayedReply,
                ts: '2026-11-19T10:05:06.000Z',
              },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-conn-4',
            data: {
              type: 'done',
              runId: RUN_ID,
              semanticStatus: 'completed',
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'state',
            state: makeThreadState({
              threadStatus: 'idle',
              activeRunId: null,
              phase: 'idle',
            }),
          }),
        );
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByTestId('chat-agent-agent-progress')).toBeVisible({
      timeout: 15_000,
    });
    expect(firstSocketRef.current).not.toBeNull();

    // Simulate transport drop and verify Reconnecting -> Restored transition.
    firstSocketRef.current?.close();

    const banner = page.getByTestId('chat-agent-connection-banner');
    await expect(banner).toContainText('Reconnecting…', { timeout: 5_000 });
    await expect(banner).toContainText('Restored', { timeout: 10_000 });
    await expect(page.getByText(replayedReply)).toHaveCount(1, {
      timeout: 10_000,
    });
    expect(reconnectLastEventId).toBe('evt-conn-1');

    const timings = await readTimings(page);
    const reconnectRecord = timings.find(
      (entry) =>
        entry.metric === 'reconnect_restored' && entry.threadId === threadId,
    );
    expect(reconnectRecord).toBeDefined();
    expect(reconnectRecord?.status).toBe('ok');
  });

  test('VT-13 AC-3: expired session (401 snapshot) clears transcript and shows sign-in prompt', async ({
    page,
    loginAsPersona,
  }) => {
    const ipv4Ready = await isLoopbackPortReachable('127.0.0.1', 3000);
    // DEFERRED: Playwright env unavailable — skip cleanly when no local E2E server is listening on 127.0.0.1:3000.
    test.skip(!ipv4Ready, '// DEFERRED: Playwright env unavailable');
    test.skip(
      typeof page.routeWebSocket !== 'function',
      '// DEFERRED: Playwright env unavailable',
    );

    const threadId = '11111111-1111-4111-8111-111111111103';
    const confidentialText = 'Confidential deployment credential audit notes';

    await initHarnessPage(page);
    await stubHomeThreadShell(page, threadId, 'idle');

    let expireSession = false;
    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        if (expireSession) {
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Authentication required' }),
          });
          return;
        }

        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-user-secret',
              role: 'user',
              text: confidentialText,
              ts: '2026-11-19T10:10:00.000Z',
            },
          ],
          state: makeThreadState({
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
          }),
          latestSummary: null,
          canWrite: true,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot),
        });
      },
    );

    const firstSocketRef: { current: WebSocketRoute | null } = { current: null };
    let wsAttempts = 0;
    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        wsAttempts += 1;
        if (wsAttempts === 1) {
          firstSocketRef.current = ws;
          ws.send(
            JSON.stringify({
              type: 'state',
              state: makeThreadState({
                threadStatus: 'idle',
                activeRunId: null,
                phase: 'idle',
              }),
            }),
          );
          return;
        }
        // Intentionally withhold the state frame so the connection's 2s
        // stateFrameTimeout triggers refreshSnapshot() and observes HTTP 401.
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByText(confidentialText)).toBeVisible({
      timeout: 15_000,
    });

    // Expire the session and drop the active socket so snapshot refresh hits 401.
    expireSession = true;
    firstSocketRef.current?.close();

    const banner = page.getByTestId('chat-agent-connection-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText(
      'Your session expired. Sign in again to continue.',
    );
    await expect(
      page.getByTestId('chat-agent-connection-banner-signin'),
    ).toBeVisible();
    await expect(page.getByText(confidentialText)).toHaveCount(0);
    await expect(page.getByTestId('chat-agent-transcript')).toHaveCount(0);
  });
});
