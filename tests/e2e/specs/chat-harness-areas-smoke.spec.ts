/**
 * VT-44 & VT-46 — PBI-018 (AC-3) / TBI-018..020:
 * End-to-end smoke checks for Standup participant chat (`standup-harness-panel`),
 * QA Lab assistant (`qa-lab-harness-panel`), and CAB release assistant
 * (`cab-release-harness-panel`), plus cumulative layout-shift <= 0.01 on first
 * paint of `AgentHarnessPanel`.
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
  HarnessAreaId,
  HarnessCommandFrame,
  HarnessReceipt,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../../../src/shared/types/chatHarness';

const RUN_ID = '50000000-0000-4000-8000-000000000046';

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

async function initHarnessPage(
  page: Page,
  options?: { measureCls?: boolean },
): Promise<void> {
  await suppressSseStreams(page);
  await suppressBetaAnnouncement(page);
  await stubAdoProjects(page);
  await page.addInitScript(
    ({ project, measureCls }: { project: string; measureCls: boolean }) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
      if (measureCls) {
        const win = window as unknown as { __APEX_CLS__?: number };
        win.__APEX_CLS__ = 0;
        if (typeof PerformanceObserver !== 'undefined') {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as Array<
              PerformanceEntry & { value?: number; hadRecentInput?: boolean }
            >) {
              if (!entry.hadRecentInput && typeof entry.value === 'number') {
                win.__APEX_CLS__ = (win.__APEX_CLS__ ?? 0) + entry.value;
              }
            }
          });
          try {
            observer.observe({ type: 'layout-shift', buffered: true });
          } catch {
            // Ignore browsers without layout-shift observer support.
          }
        }
      }
    },
    { project: E2E_PROJECT, measureCls: Boolean(options?.measureCls) },
  );
}

function makeState(
  area: HarnessAreaId,
  overrides: Partial<HarnessThreadState> = {},
): HarnessThreadState {
  return {
    threadStatus: 'idle',
    activeRunId: null,
    phase: 'idle',
    harnessArea: area,
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

test.describe('Chat harness areas smoke and CLS budget (VT-44 / VT-46)', () => {
  test('VT-46: Standup participant chat (standup-harness-panel) supports send, live work box, Stop, and preserved testids', async ({
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

    const threadId = '33333333-3333-4333-8333-333333333301';
    const idleState = makeState('standup-participant');
    const runningState = makeState('standup-participant', {
      threadStatus: 'running',
      activeRunId: RUN_ID,
      phase: 'running',
    });

    await initHarnessPage(page);

    await page.route('**/api/standup/my-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          participantId: 'participant-smoke-1',
          sessionId: 'standup-session-smoke-1',
          threadId,
          status: 'in_progress',
          sessionDate: '2026-11-19',
          sessionStatus: 'open',
        }),
      });
    });

    await page.route(
      `**/api/standup/threads/${threadId}/sync-token`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.route(`**/api/chat/threads/${threadId}`, async (route) => {
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
          status: 'idle',
          workspaceDir: `/tmp/${threadId}`,
          flagged: false,
          createdAt: '2026-11-19T09:00:00.000Z',
          lastActivityAt: '2026-11-19T09:00:00.000Z',
        }),
      });
    });

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-standup-greeting',
              role: 'agent',
              text: 'Good morning! What did you complete yesterday?',
              ts: '2026-11-19T09:00:01.000Z',
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

    let cancelReceived = false;
    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        ws.send(JSON.stringify({ type: 'state', state: idleState }));

        ws.onMessage((payload) => {
          const frame = parseCommandFrame(payload);
          if (!frame) return;

          if (frame.kind === 'send') {
            ws.send(
              JSON.stringify({
                type: 'receipt',
                receipt: {
                  commandId: frame.commandId,
                  kind: 'send',
                  status: 'accepted',
                  runId: RUN_ID,
                  updatedAt: '2026-11-19T09:00:05.000Z',
                } satisfies HarnessReceipt,
              }),
            );
            ws.send(JSON.stringify({ type: 'state', state: runningState }));
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-standup-think',
                data: {
                  type: 'thinking',
                  seq: 1,
                  text: 'Reviewing your assigned work items',
                },
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-standup-tool',
                data: {
                  type: 'tool_status',
                  callId: 'call-standup-1',
                  toolName: 'ado_work_items',
                  status: 'running',
                  args: { target: 'Assigned PBIs' },
                },
              }),
            );
          } else if (frame.kind === 'cancel') {
            cancelReceived = true;
            ws.send(
              JSON.stringify({
                type: 'receipt',
                receipt: {
                  commandId: frame.commandId,
                  kind: 'cancel',
                  status: 'applied',
                  runId: RUN_ID,
                  updatedAt: '2026-11-19T09:00:08.000Z',
                } satisfies HarnessReceipt,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-standup-done',
                data: {
                  type: 'done',
                  runId: RUN_ID,
                  semanticStatus: 'cancelled',
                },
              }),
            );
            ws.send(JSON.stringify({ type: 'state', state: idleState }));
          }
        });
      },
    );

    await loginAsPersona('developer');
    await page.goto('/standup', { waitUntil: 'domcontentloaded' });

    // Preserved Standup data-testids.
    await expect(page.getByTestId('standup-harness-panel')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('standup-composer')).toBeVisible();
    await expect(page.getByTestId('standup-submit-btn')).toBeVisible();
    await expect(page.getByTestId('standup-file-input')).toBeAttached();

    // Send -> live work box -> Stop.
    await page
      .getByTestId('standup-message-input')
      .fill('Finished PBI #1001 and moving to integration tests.');
    await page.getByTestId('standup-send-btn').click();

    await expect(page.getByTestId('standup-streaming')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('standup-agent-progress')).toBeVisible();
    await expect(page.getByTestId('standup-stop-btn')).toBeVisible();

    await page.getByTestId('standup-stop-btn').click();
    await expect.poll(() => cancelReceived).toBe(true);
    await expect(page.getByTestId('standup-send-btn')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('VT-46: QA Lab assistant (qa-lab-harness-panel) supports thought process drawer, send, live work box, Stop, and preserved testids', async ({
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

    const workItemId = 4201;
    const prdId = 'prd-qa-smoke-4201';
    const threadId = '33333333-3333-4333-8333-333333333302';
    const idleState = makeState('qa-lab');
    const runningState = makeState('qa-lab', {
      threadStatus: 'running',
      activeRunId: RUN_ID,
      phase: 'running',
    });

    await initHarnessPage(page);

    await page.route('**/api/interviews/work-items?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: workItemId,
              title: 'QA Harness Smoke PBI',
              state: 'Active',
              workItemType: 'Product Backlog Item',
            },
          ],
          truncated: false,
        }),
      });
    });

    await page.route(
      `**/api/interviews/work-items/${workItemId}/test-cases*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            workItemId,
            suites: [],
            sources: [],
            totalCases: 0,
            generation: {
              prdId,
              prdTitle: 'QA Smoke PRD',
              matchLevel: 'pbi',
              matchedTitle: 'QA Harness Smoke PBI',
              pbiIds: ['PBI-001'],
              pbiTargets: [{ pbiId: 'PBI-001', title: 'QA Harness Smoke PBI' }],
              testCaseStatus: 'ready',
              testCaseThreadId: null,
            },
            externalSuite: null,
          }),
        });
      },
    );

    await page.route(
      `**/api/interviews/prds/${prdId}/assistant-thread`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ threadId }),
        });
      },
    );

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-qa-saved-1',
              role: 'agent',
              text: 'I reviewed the PRD acceptance criteria and identified 2 boundary gaps.',
              ts: '2026-11-19T09:10:00.000Z',
              activity: [
                {
                  id: 'qa-think-1',
                  kind: 'thinking',
                  text: 'Mapped acceptance criteria against existing test matrix',
                },
                {
                  id: 'qa-tool-1',
                  kind: 'tool',
                  toolName: 'read_file',
                  status: 'completed',
                  target: 'prd-qa-smoke.md',
                },
              ],
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

    let cancelReceived = false;
    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        ws.send(JSON.stringify({ type: 'state', state: idleState }));

        ws.onMessage((payload) => {
          const frame = parseCommandFrame(payload);
          if (!frame) return;

          if (frame.kind === 'send') {
            ws.send(
              JSON.stringify({
                type: 'receipt',
                receipt: {
                  commandId: frame.commandId,
                  kind: 'send',
                  status: 'accepted',
                  runId: RUN_ID,
                  updatedAt: '2026-11-19T09:10:05.000Z',
                } satisfies HarnessReceipt,
              }),
            );
            ws.send(JSON.stringify({ type: 'state', state: runningState }));
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-qa-think',
                data: {
                  type: 'thinking',
                  seq: 1,
                  text: 'Drafting negative authorization cases',
                },
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-qa-tool',
                data: {
                  type: 'tool_status',
                  callId: 'call-qa-1',
                  toolName: 'add_test_case',
                  status: 'running',
                  args: { target: 'TC-Negative-Auth' },
                },
              }),
            );
          } else if (frame.kind === 'cancel') {
            cancelReceived = true;
            ws.send(
              JSON.stringify({
                type: 'receipt',
                receipt: {
                  commandId: frame.commandId,
                  kind: 'cancel',
                  status: 'applied',
                  runId: RUN_ID,
                  updatedAt: '2026-11-19T09:10:09.000Z',
                } satisfies HarnessReceipt,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-qa-done',
                data: {
                  type: 'done',
                  runId: RUN_ID,
                  semanticStatus: 'cancelled',
                },
              }),
            );
            ws.send(JSON.stringify({ type: 'state', state: idleState }));
          }
        });
      },
    );

    await loginAsPersona('developer');
    await page.goto('/qa-lab', { waitUntil: 'domcontentloaded' });

    await page.getByTestId(`qa-lab-work-item-${workItemId}`).click();
    await page.getByTestId('qa-lab-open-assistant').click();

    // Preserved QA Lab data-testids.
    await expect(page.getByTestId('qa-lab-assistant-panel')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('qa-lab-harness-panel')).toBeVisible();
    await expect(page.getByTestId('qa-lab-assistant-context')).toBeVisible();
    await expect(page.getByTestId('qa-lab-assistant-close-btn')).toBeVisible();

    // Thought process drawer opens to show saved reasoning and tools.
    const drawer = page.getByTestId('qa-lab-assistant-thought-process');
    const toggle = page.getByTestId('qa-lab-assistant-thought-process-toggle');
    await expect(drawer).toBeVisible();
    await toggle.click();
    await expect(drawer).toHaveAttribute('open', '');
    await expect(drawer).toContainText(
      'Mapped acceptance criteria against existing test matrix',
    );

    // Send -> live work box -> Stop.
    await page
      .getByTestId('qa-lab-assistant-message-input')
      .fill('Add negative test cases for read-only users.');
    await page.getByTestId('qa-lab-assistant-send-btn').click();

    await expect(page.getByTestId('qa-lab-assistant-streaming')).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByTestId('qa-lab-assistant-agent-progress'),
    ).toBeVisible();
    await expect(page.getByTestId('qa-lab-assistant-stop-btn')).toBeVisible();

    await page.getByTestId('qa-lab-assistant-stop-btn').click();
    await expect.poll(() => cancelReceived).toBe(true);
    await expect(page.getByTestId('qa-lab-assistant-send-btn')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('VT-46: CAB release assistant (cab-release-harness-panel) supports live work box, Stop, send, thought process drawer, and preserved testids', async ({
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

    const epicId = 9001;
    const threadId = '33333333-3333-4333-8333-333333333303';
    const idleState = makeState('cab-release');
    const runningState = makeState('cab-release', {
      threadStatus: 'running',
      activeRunId: RUN_ID,
      phase: 'running',
    });

    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await page.addInitScript((project: string) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);

    await page.route('**/api/feature-flags/evaluate*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          flags: {
            'beta-to-prod-announcement': false,
            'release-cab-request': true,
            'ai-runs-v2-transport': true,
          },
        }),
      });
    });

    await page.route('**/api/deployments*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/epics/*/children*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/features/*/children*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route(/\/api\/releases(?:\/|\?|$)/, async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      const method = route.request().method().toUpperCase();

      if (pathname === '/api/releases/epics' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: epicId,
              version: '2026.19.0',
              status: 'In Progress',
              startDate: '2026-11-10',
              targetDate: '2026-11-24',
              description: 'CAB harness smoke release',
              tags: 'ReleaseVersion',
              totalItems: 1,
              completedItems: 1,
              greenItems: 1,
              amberItems: 0,
              redItems: 0,
              progress: 100,
              childItemsSummary: [
                {
                  id: 9101,
                  state: 'Ready For Release',
                  workItemType: 'Product Backlog Item',
                  tags: '',
                },
              ],
            },
          ]),
        });
        return;
      }

      if (pathname === '/api/releases' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }

      if (
        pathname === `/api/releases/${epicId}/related-items` &&
        method === 'GET'
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 9101,
              title: 'CAB smoke feature',
              state: 'Ready For Release',
              workItemType: 'Product Backlog Item',
              tags: '',
              areaPath: E2E_PROJECT,
              iterationPath: E2E_PROJECT,
              changedDate: '2026-11-19T09:00:00.000Z',
              createdDate: '2026-11-19T09:00:00.000Z',
            },
          ]),
        });
        return;
      }

      await route.continue();
    });

    await page.route('**/api/skill-config*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'skill-cfg-smoke-1',
          project: E2E_PROJECT,
          skillRepo: 'AI-Pilot',
          skillBranch: 'main',
          skillProvider: 'ado',
        }),
      });
    });

    await page.route('**/api/chat/threads', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ threadId, id: threadId }),
        });
        return;
      }
      await route.continue();
    });

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [],
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

    let sendCount = 0;
    let cancelReceived = false;

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        ws.send(JSON.stringify({ type: 'state', state: idleState }));

        ws.onMessage((payload) => {
          const frame = parseCommandFrame(payload);
          if (!frame) return;

          if (frame.kind === 'send') {
            sendCount += 1;
            ws.send(
              JSON.stringify({
                type: 'receipt',
                receipt: {
                  commandId: frame.commandId,
                  kind: 'send',
                  status: 'accepted',
                  runId: RUN_ID,
                  updatedAt: '2026-11-19T09:20:05.000Z',
                } satisfies HarnessReceipt,
              }),
            );
            ws.send(JSON.stringify({ type: 'state', state: runningState }));
            ws.send(
              JSON.stringify({
                type: 'event',
                id: `evt-cab-think-${sendCount}`,
                data: {
                  type: 'thinking',
                  seq: sendCount,
                  text: 'Collecting CAB release delta commits',
                },
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                id: `evt-cab-tool-${sendCount}`,
                data: {
                  type: 'tool_status',
                  callId: `call-cab-${sendCount}`,
                  toolName: 'git_diff',
                  status: sendCount === 1 ? 'running' : 'completed',
                  args: { target: 'Release/2026.18.0..development' },
                },
              }),
            );

            if (sendCount >= 2) {
              ws.send(
                JSON.stringify({
                  type: 'event',
                  id: `evt-cab-msg-${sendCount}`,
                  data: {
                    type: 'message',
                    message: {
                      id: `msg-cab-agent-${sendCount}`,
                      role: 'agent',
                      text: 'Dry-run CAB summary drafted with 1 linked PBI.',
                      ts: '2026-11-19T09:20:15.000Z',
                      activity: [
                        {
                          id: 'cab-saved-think',
                          kind: 'thinking',
                          text: 'Validated SNOW dry-run definition 670',
                        },
                      ],
                    },
                  },
                }),
              );
              ws.send(
                JSON.stringify({
                  type: 'event',
                  id: `evt-cab-done-${sendCount}`,
                  data: {
                    type: 'done',
                    runId: RUN_ID,
                    semanticStatus: 'completed',
                  },
                }),
              );
              ws.send(JSON.stringify({ type: 'state', state: idleState }));
            }
          } else if (frame.kind === 'cancel') {
            cancelReceived = true;
            ws.send(
              JSON.stringify({
                type: 'receipt',
                receipt: {
                  commandId: frame.commandId,
                  kind: 'cancel',
                  status: 'applied',
                  runId: RUN_ID,
                  updatedAt: '2026-11-19T09:20:09.000Z',
                } satisfies HarnessReceipt,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'event',
                id: 'evt-cab-cancelled',
                data: {
                  type: 'done',
                  runId: RUN_ID,
                  semanticStatus: 'cancelled',
                },
              }),
            );
            ws.send(JSON.stringify({ type: 'state', state: idleState }));
          }
        });
      },
    );

    await loginAsPersona('developer');
    await page.goto('/planning/releases', { waitUntil: 'domcontentloaded' });

    await page.getByTestId(`release-actions-${epicId}`).click();
    await page.getByTestId(`release-create-cab-${epicId}`).click();
    await expect(page.getByTestId('create-cab-request-modal')).toBeVisible();
    await page.getByTestId('create-cab-previous-branch').fill('Release/2026.18.0');
    await page.getByTestId('create-cab-confirm').click();

    // Preserved CAB Release data-testids.
    await expect(page.getByTestId('cab-release-assistant-panel')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('cab-release-harness-panel')).toBeVisible();
    await expect(
      page.getByTestId('cab-release-proposal-banner'),
    ).toBeVisible();

    // Kickoff turn triggers live work box; Stop halts it.
    await expect(
      page.getByTestId('cab-release-assistant-streaming'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId('cab-release-assistant-agent-progress'),
    ).toBeVisible();
    await expect(
      page.getByTestId('cab-release-assistant-stop-btn'),
    ).toBeVisible();

    await page.getByTestId('cab-release-assistant-stop-btn').click();
    await expect.poll(() => cancelReceived).toBe(true);

    // Follow-up send completes with a saved thought process drawer.
    await page
      .getByTestId('cab-release-assistant-message-input')
      .fill('Summarize the dry-run delta.');
    await page.getByTestId('cab-release-assistant-send-btn').click();

    const drawer = page.getByTestId('cab-release-assistant-thought-process');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await page
      .getByTestId('cab-release-assistant-thought-process-toggle')
      .click();
    await expect(drawer).toHaveAttribute('open', '');
    await expect(drawer).toContainText(
      'Validated SNOW dry-run definition 670',
    );
  });

  test('VT-44: AgentHarnessPanel first paint stays within cumulative layout-shift budget (CLS <= 0.01)', async ({
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

    const threadId = '33333333-3333-4333-8333-333333333304';
    const idleState = makeState('agent-home');

    await initHarnessPage(page, { measureCls: true });

    await page.route(`**/api/chat/threads/${threadId}`, async (route) => {
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
          status: 'idle',
          workspaceDir: `/tmp/${threadId}`,
          flagged: false,
          createdAt: '2026-11-19T09:30:00.000Z',
          lastActivityAt: '2026-11-19T09:30:00.000Z',
        }),
      });
    });

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'msg-cls-user',
              role: 'user',
              text: 'Show current sprint blockers.',
              ts: '2026-11-19T09:30:01.000Z',
            },
            {
              id: 'msg-cls-agent',
              role: 'agent',
              text: 'There are currently no critical blockers in sprint 19.',
              ts: '2026-11-19T09:30:04.000Z',
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

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        ws.send(JSON.stringify({ type: 'state', state: idleState }));
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByTestId('chat-agent-harness-panel')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText('There are currently no critical blockers in sprint 19.'),
    ).toBeVisible();

    // Allow two animation frames after hydration so layout-shift entries flush.
    const cls = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const win = window as unknown as { __APEX_CLS__?: number };
              resolve(typeof win.__APEX_CLS__ === 'number' ? win.__APEX_CLS__ : 0);
            });
          });
        }),
    );

    expect(cls).toBeLessThanOrEqual(0.01);
  });
});
