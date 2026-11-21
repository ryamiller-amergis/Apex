/**
 * VT-52 — PBI-017 (AC-0..4) & PBI-011 (AC-3):
 * Owner mid-turn steering (accepted + applied, over-cap rejection keeping draft),
 * manual Summarize (running notice + trimmed fallback notice), and read-only
 * second view enforcement (`canWrite: false`).
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
  HarnessCommandFrame,
  HarnessReceipt,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../../../src/shared/types/chatHarness';

const RUN_ID = '50000000-0000-4000-8000-000000000052';

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
  status: 'idle' | 'running',
  ownerId: string = PERSONA_OIDS.developer,
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
        userId: ownerId,
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
        createdAt: '2026-11-19T10:20:00.000Z',
        lastActivityAt: '2026-11-19T10:20:00.000Z',
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

function parseCommandFrame(raw: string | Buffer): HarnessCommandFrame | null {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const parsed = JSON.parse(text) as { type?: string };
    if (parsed && parsed.type === 'command') {
      return parsed as HarnessCommandFrame;
    }
  } catch {
    // Ignore non-JSON frames.
  }
  return null;
}

test.describe('Chat harness steer, summarize, and read-only enforcement (VT-52 / PBI-017)', () => {
  test('VT-52 AC-0/AC-1: owner steers running turn (Steer sent) and over-cap rejection keeps draft', async ({
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

    const threadId = '22222222-2222-4222-8222-222222222201';
    const runningState = makeThreadState();

    await initHarnessPage(page);
    await stubHomeThreadShell(page, threadId, 'running');

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-steer-user-1',
              role: 'user',
              text: 'Audit our service endpoints and summarize risks.',
              ts: '2026-11-19T10:20:01.000Z',
            },
          ],
          state: runningState,
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

    let steerCount = 0;
    const receivedSteerTexts: string[] = [];

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        ws.send(JSON.stringify({ type: 'state', state: runningState }));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: 'evt-steer-think-1',
            data: {
              type: 'thinking',
              seq: 1,
              text: 'Scanning route handlers for auth coverage',
            },
          }),
        );

        ws.onMessage((payload) => {
          const frame = parseCommandFrame(payload);
          if (!frame || frame.kind !== 'steer') return;
          steerCount += 1;
          receivedSteerTexts.push(frame.text);

          if (steerCount === 1) {
            const accepted: HarnessReceipt = {
              commandId: frame.commandId,
              kind: 'steer',
              status: 'accepted',
              runId: RUN_ID,
              updatedAt: '2026-11-19T10:20:05.000Z',
            };
            const applied: HarnessReceipt = {
              commandId: frame.commandId,
              kind: 'steer',
              status: 'applied',
              runId: RUN_ID,
              updatedAt: '2026-11-19T10:20:06.000Z',
            };
            ws.send(JSON.stringify({ type: 'receipt', receipt: accepted }));
            ws.send(JSON.stringify({ type: 'receipt', receipt: applied }));
            return;
          }

          const rejected: HarnessReceipt = {
            commandId: frame.commandId,
            kind: 'steer',
            status: 'rejected',
            reason: 'Wait for this step to finish',
            runId: RUN_ID,
            updatedAt: '2026-11-19T10:20:08.000Z',
          };
          ws.send(JSON.stringify({ type: 'receipt', receipt: rejected }));
        });
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    const input = page.getByTestId('chat-agent-message-input');
    const steerBtn = page.getByTestId('chat-agent-composer-steer');
    const receipt = page.getByTestId('chat-agent-composer-receipt');

    await expect(steerBtn).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('chat-agent-stop-btn')).toBeVisible();

    // First steer succeeds: shows "Steer sent" and clears draft.
    await input.fill('Prioritize authentication routes first.');
    await expect(steerBtn).toBeEnabled();
    await steerBtn.click();

    await expect(receipt).toContainText('Steer sent', { timeout: 5_000 });
    await expect(input).toHaveValue('');

    // Over-cap steer is rejected: shows "Wait for this step to finish" and keeps draft.
    const overCapDraft = 'Also check rate limit headers on public APIs.';
    await input.fill(overCapDraft);
    await steerBtn.click();

    await expect(receipt).toContainText('Wait for this step to finish', {
      timeout: 5_000,
    });
    await expect(input).toHaveValue(overCapDraft);
    expect(receivedSteerTexts).toEqual([
      'Prioritize authentication routes first.',
      overCapDraft,
    ]);
  });

  test('VT-52 AC-2/AC-3: Summarize shows Summarizing conversation… then trimmed fallback warning', async ({
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

    const threadId = '22222222-2222-4222-8222-222222222202';
    const idleState = makeThreadState({
      threadStatus: 'idle',
      activeRunId: null,
      phase: 'idle',
    });

    await initHarnessPage(page);
    await stubHomeThreadShell(page, threadId, 'idle');

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-sum-user',
              role: 'user',
              text: 'Walk through the architecture trade-offs.',
              ts: '2026-11-19T10:25:00.000Z',
            },
            {
              id: 'msg-sum-agent',
              role: 'agent',
              text: 'Here are the main durability and latency trade-offs.',
              ts: '2026-11-19T10:25:04.000Z',
            },
          ],
          state: idleState,
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

    const activeWsRef: { current: WebSocketRoute | null } = { current: null };
    const summarizeCommandIdRef: { current: string | null } = { current: null };

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        activeWsRef.current = ws;
        ws.send(JSON.stringify({ type: 'state', state: idleState }));

        ws.onMessage((payload) => {
          const frame = parseCommandFrame(payload);
          if (!frame || frame.kind !== 'summarize') return;
          summarizeCommandIdRef.current = frame.commandId;

          ws.send(
            JSON.stringify({
              type: 'receipt',
              receipt: {
                commandId: frame.commandId,
                kind: 'summarize',
                status: 'accepted',
                updatedAt: '2026-11-19T10:25:10.000Z',
              } satisfies HarnessReceipt,
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'state',
              state: makeThreadState({
                threadStatus: 'idle',
                activeRunId: null,
                phase: 'summarizing',
              }),
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-sum-running',
              data: { type: 'summary', status: 'running' },
            }),
          );
        });
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    const summarizeBtn = page.getByTestId('chat-agent-composer-summarize');
    const summaryNotice = page.getByTestId('chat-agent-summary-notice');

    await expect(summarizeBtn).toBeVisible({ timeout: 15_000 });
    await expect(summarizeBtn).toBeEnabled();
    await summarizeBtn.click();

    await expect(summaryNotice).toBeVisible({ timeout: 5_000 });
    await expect(summaryNotice).toContainText('Summarizing conversation…');
    await expect(summarizeBtn).toBeDisabled();

    // Complete summarization with trimmed fallback marker.
    const ws = activeWsRef.current;
    const summarizeCommandId = summarizeCommandIdRef.current;
    expect(ws).not.toBeNull();
    expect(summarizeCommandId).not.toBeNull();
    if (!ws || !summarizeCommandId) {
      throw new Error('Expected active summarize WebSocket and commandId');
    }
    ws.send(
      JSON.stringify({
        type: 'state',
        state: makeThreadState({
          threadStatus: 'idle',
          activeRunId: null,
          phase: 'idle',
          latestSummary: {
            id: 'summary-marker-1',
            source: 'user',
            fallback: true,
            createdAt: '2026-11-19T10:25:14.000Z',
          },
        }),
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'event',
        id: 'evt-sum-fallback',
        data: { type: 'summary', status: 'fallback' },
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'receipt',
        receipt: {
          commandId: summarizeCommandId,
          kind: 'summarize',
          status: 'applied',
          updatedAt: '2026-11-19T10:25:14.000Z',
        } satisfies HarnessReceipt,
      }),
    );

    await expect(summaryNotice).toContainText(
      'Only a trimmed transcript was kept for this conversation.',
      { timeout: 5_000 },
    );
    await expect(summarizeBtn).toBeEnabled();
  });

  test('VT-52 AC-4 / PBI-011 AC-3: read-only second view (canWrite: false) sees live work box while Send/Steer/Summarize/Stop are disabled', async ({
    browser,
  }) => {
    const ipv4Ready = await isLoopbackPortReachable('127.0.0.1', 3000);
    // DEFERRED: Playwright env unavailable — skip cleanly when no local E2E server is listening on 127.0.0.1:3000.
    test.skip(!ipv4Ready, '// DEFERRED: Playwright env unavailable');

    const threadId = '22222222-2222-4222-8222-222222222203';
    const runningReadOnlyState = makeThreadState({ canWrite: false });
    const idleReadOnlyState = makeThreadState({
      threadStatus: 'idle',
      activeRunId: null,
      phase: 'idle',
      canWrite: false,
    });

    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();

    try {
      test.skip(
        typeof viewerPage.routeWebSocket !== 'function',
        '// DEFERRED: Playwright env unavailable',
      );

      await initHarnessPage(viewerPage);
      await stubHomeThreadShell(
        viewerPage,
        threadId,
        'running',
        PERSONA_OIDS.developer,
      );

      await viewerPage.route(
        `**/api/harness/threads/${threadId}/snapshot`,
        async (route) => {
          const snapshot: HarnessThreadSnapshot = {
            messages: [
              {
                id: 'msg-ro-user-1',
                role: 'user',
                text: 'Owner prompt in shared thread.',
                ts: '2026-11-19T10:30:00.000Z',
              },
            ],
            state: runningReadOnlyState,
            latestSummary: null,
            canWrite: false,
          };
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(snapshot),
          });
        },
      );

      const viewerWsRef: { current: WebSocketRoute | null } = { current: null };
      const viewerCommands: HarnessCommandFrame[] = [];

      await viewerPage.routeWebSocket(
        `**/api/interactive/threads/${threadId}/stream*`,
        (ws: WebSocketRoute) => {
          viewerWsRef.current = ws;
          ws.send(
            JSON.stringify({ type: 'state', state: runningReadOnlyState }),
          );
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-ro-think',
              data: {
                type: 'thinking',
                seq: 1,
                text: 'Inspecting shared sprint metrics',
              },
            }),
          );
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-ro-tool',
              data: {
                type: 'tool_status',
                callId: 'call-ro-1',
                toolName: 'read_file',
                status: 'running',
                args: { target: 'sprint-metrics.json' },
              },
            }),
          );
          ws.onMessage((payload) => {
            const frame = parseCommandFrame(payload);
            if (frame) viewerCommands.push(frame);
          });
        },
      );

      // Sign in as a non-owner viewer persona (`qa`) in the isolated second view.
      await viewerPage.request.post('http://127.0.0.1:3000/auth/dev-login', {
        data: { persona: 'qa' },
      });
      await viewerPage.goto(`/home?thread=${threadId}`, {
        waitUntil: 'domcontentloaded',
      });

      // Viewer sees the live work box while all write controls remain disabled.
      await expect(
        viewerPage.getByTestId('chat-agent-agent-progress'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        viewerPage.getByTestId('chat-agent-readonly-notice'),
      ).toBeVisible();
      await expect(
        viewerPage.getByTestId('chat-agent-message-input'),
      ).toBeDisabled();
      await expect(
        viewerPage.getByTestId('chat-agent-composer-steer'),
      ).toBeDisabled();
      await expect(
        viewerPage.getByTestId('chat-agent-composer-summarize'),
      ).toBeDisabled();
      await expect(
        viewerPage.getByTestId('chat-agent-stop-btn'),
      ).toBeDisabled();

      // Transition turn to idle and verify Send and Summarize remain disabled.
      const ws = viewerWsRef.current;
      expect(ws).not.toBeNull();
      if (!ws) {
        throw new Error('Expected active viewer WebSocket');
      }
      ws.send(
        JSON.stringify({
          type: 'event',
          id: 'evt-ro-done',
          data: { type: 'done', runId: RUN_ID, semanticStatus: 'completed' },
        }),
      );
      ws.send(JSON.stringify({ type: 'state', state: idleReadOnlyState }));

      await expect(
        viewerPage.getByTestId('chat-agent-send-btn'),
      ).toBeDisabled({ timeout: 10_000 });
      await expect(
        viewerPage.getByTestId('chat-agent-composer-summarize'),
      ).toBeDisabled();
      expect(viewerCommands).toHaveLength(0);
    } finally {
      await viewerContext.close();
    }
  });
});
