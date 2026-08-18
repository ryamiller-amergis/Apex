/**
 * FEAT-007 / TBI-009 — Session Timeline merge, verdict, hang point, cursor, and safe projection.
 * Criterion ids: DoD-0, DoD-1, DoD-2, VT-01–VT-09, VT-13.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunHealth } from '../../shared/types/chat';
import { TRACE_REDACTED_MARKER } from '../../shared/types/observability';
import {
  compareSessionTimelineEntries,
  getSessionTimeline,
  projectAgentEntry,
  projectTraceEntry,
  type CanonicalRunRow,
  type DurableRunEventRow,
  type SessionTimelineLoaders,
} from '../services/observabilitySessionTimeline';
import { ObservabilityQueryError } from '../services/observabilityQueryValidation';
import { assessAgentRunHealth, resolveAgentRunHealthConfig } from '../services/agentRunReaperService';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = 'run-1';
const NOW = Date.parse('2026-08-17T18:00:00.000Z');
const CONFIG = resolveAgentRunHealthConfig();

function run(overrides: Partial<CanonicalRunRow> = {}): CanonicalRunRow {
  return {
    id: RUN_ID,
    status: 'running',
    createdAt: '2026-08-17T17:50:00.000Z',
    startedAt: '2026-08-17T17:50:00.000Z',
    heartbeatAt: '2026-08-17T17:59:30.000Z',
    progressAt: '2026-08-17T17:59:00.000Z',
    progressLabel: 'edit completed',
    timeoutAt: '2026-08-17T20:00:00.000Z',
    lastError: null,
    ...overrides,
  };
}

function agentEvent(overrides: Partial<DurableRunEventRow> = {}): DurableRunEventRow {
  return {
    eventId: 'evt-agent-1',
    runId: RUN_ID,
    eventType: 'phase',
    phase: 'implementation',
    status: 'completed',
    detail: 'Planning complete',
    occurredAt: '2026-08-17T17:51:00.000Z',
    sequence: 1,
    ordinal: 1,
    ...overrides,
  };
}

function identity(runs: CanonicalRunRow[] = [run()]) {
  return {
    sessionId: SESSION_ID,
    interviewId: '33333333-3333-4333-8333-333333333333',
    startedAt: '2026-08-17T17:50:00.000Z',
    runs,
  };
}

function loaders(options: {
  identity?: ReturnType<typeof identity> | null;
  identityError?: Error;
  agent?: DurableRunEventRow[];
  agentError?: Error;
  traces?: Parameters<typeof projectTraceEntry>[0][];
  traceError?: Error;
}): SessionTimelineLoaders {
  return {
    loadSessionIdentity: async () => {
      if (options.identityError) throw options.identityError;
      return options.identity === undefined ? identity() : options.identity;
    },
    loadDurableEvents: async () => {
      if (options.agentError) throw options.agentError;
      return options.agent ?? [agentEvent()];
    },
    loadTraceOverlays: async () => {
      if (options.traceError) throw options.traceError;
      return options.traces ?? [
        {
          id: 'evt-trace-1',
          eventType: 'api_request',
          occurredAt: '2026-08-17T17:51:00.000Z',
          actorId: '11111111-1111-4111-8111-111111111111',
          projectId: 'Apex',
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          sessionId: SESSION_ID,
          routeTemplate: '/api/interviews/:id',
          method: 'GET',
          statusCode: 200,
          durationMs: 12,
          severity: 'info',
          trigger: 'human',
          diagnosticSummary: 'ok',
        },
        {
          id: 'evt-trace-2',
          eventType: 'error',
          occurredAt: '2026-08-17T17:52:00.000Z',
          actorId: '11111111-1111-4111-8111-111111111111',
          projectId: 'Apex',
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          sessionId: SESSION_ID,
          routeTemplate: '/api/interviews/:id/message',
          method: 'POST',
          statusCode: 500,
          durationMs: 40,
          severity: 'error',
          trigger: 'human',
          diagnosticSummary: 'scrubbed failure',
        },
      ];
    },
  };
}

describe('observabilitySessionTimeline', () => {
  it('DoD-0 / VT-01 returns one ordered mixed-source timeline with verdict and hang point', async () => {
    const hanging = agentEvent({
      eventId: 'hang-tool',
      eventType: 'tool',
      status: 'running',
      toolName: 'edit',
      occurredAt: '2026-08-17T17:54:00.000Z',
      sequence: 4,
      ordinal: 4,
    });
    const healthEvent = agentEvent({
      eventId: 'health-1',
      eventType: 'health',
      status: 'failed',
      health: 'progress_timeout',
      occurredAt: '2026-08-17T17:55:00.000Z',
      sequence: 5,
      ordinal: 5,
      detail: 'progress timeout',
    });
    const page = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      {
        loaders: loaders({
          identity: identity([
            run({
              status: 'failed',
              lastError: 'run aborted after progress timeout',
              progressAt: '2026-08-17T17:50:00.000Z',
            }),
          ]),
          agent: [agentEvent(), hanging, healthEvent],
        }),
        now: () => NOW,
      },
    );

    expect(page.partial).toBe(false);
    expect(page.entries.map((entry) => entry.source)).toEqual(['agent', 'trace', 'trace', 'agent', 'agent']);
    expect(page.verdict.health).toBe('progress_timeout');
    expect(page.verdict.hangPointEventId).toBe('health-1');
    expect(page.session.interviewId).toBe('33333333-3333-4333-8333-333333333333');
    expect(JSON.stringify(page)).not.toMatch(/chat_messages|authorization|stack/i);
  });

  it('DoD-1 / VT-02 reuses assessAgentRunHealth for every supported active-run verdict', () => {
    const cases: Array<{ health: AgentRunHealth; snapshot: Partial<CanonicalRunRow> }> = [
      { health: 'healthy', snapshot: {} },
      {
        health: 'progress_stale',
        snapshot: { progressAt: new Date(NOW - CONFIG.progressStaleMs).toISOString() },
      },
      {
        health: 'progress_timeout',
        snapshot: { progressAt: new Date(NOW - CONFIG.progressAbortMs).toISOString() },
      },
      {
        health: 'long_running',
        snapshot: {
          startedAt: new Date(NOW - CONFIG.longRunMs).toISOString(),
          progressAt: new Date(NOW - 1_000).toISOString(),
        },
      },
      {
        health: 'worker_lost',
        snapshot: { heartbeatAt: new Date(NOW - CONFIG.heartbeatTimeoutMs).toISOString() },
      },
      {
        health: 'hard_timeout',
        snapshot: { timeoutAt: new Date(NOW - 1_000).toISOString() },
      },
      {
        health: 'never_claimed',
        snapshot: {
          status: 'queued',
          createdAt: new Date(NOW - CONFIG.queuedTimeoutMs).toISOString(),
          startedAt: null,
        },
      },
    ];

    for (const { health, snapshot } of cases) {
      const row = run(snapshot);
      expect(assessAgentRunHealth(row, NOW, CONFIG)).toBe(health);
    }
  });

  it('DoD-1 / VT-02 query maps each active classifier verdict onto the timeline response', async () => {
    const page = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      {
        loaders: loaders({
          identity: identity([
            run({ heartbeatAt: new Date(NOW - CONFIG.heartbeatTimeoutMs).toISOString() }),
          ]),
          traces: [],
        }),
        now: () => NOW,
      },
    );
    expect(page.verdict.health).toBe('worker_lost');
    expect(page.verdict.label).toBe('Worker lost');
  });

  it('VT-03 preserves a persisted terminal watchdog verdict when wall clock advances', async () => {
    const later = NOW + 24 * 60 * 60_000;
    const page = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      {
        loaders: loaders({
          identity: identity([
            run({
              status: 'failed',
              lastError: 'Worker lost: heartbeat stopped',
            }),
          ]),
          agent: [
            agentEvent({
              eventId: 'watchdog-health',
              eventType: 'health',
              health: 'worker_lost',
              status: 'failed',
              occurredAt: '2026-08-17T17:58:00.000Z',
              sequence: 9,
            }),
          ],
          traces: [],
        }),
        now: () => later,
      },
    );
    expect(page.verdict.health).toBe('worker_lost');
    expect(page.verdict.hangPointEventId).toBe('watchdog-health');
  });

  it('DoD-2 / VT-04 keeps lifecycle rows and marks the timeline partial when traces fail', async () => {
    const page = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      {
        loaders: loaders({ traceError: new Error('trace store down') }),
        now: () => NOW,
      },
    );
    expect(page.partial).toBe(true);
    expect(page.sourceStatus.trace.state).toBe('failed');
    expect(page.sourceStatus.agent.state).toBe('complete');
    expect(page.entries.every((entry) => entry.source === 'agent')).toBe(true);
    expect(page.entries.length).toBeGreaterThan(0);
  });

  it('DoD-2 / VT-05 keeps trace overlays and withholds the verdict when lifecycle fails', async () => {
    const page = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      {
        loaders: loaders({ agentError: new Error('agent store down') }),
        now: () => NOW,
      },
    );
    expect(page.partial).toBe(true);
    expect(page.sourceStatus.agent.state).toBe('failed');
    expect(page.sourceStatus.trace.state).toBe('complete');
    expect(page.verdict.health).toBeNull();
    expect(page.verdict.label).toBe('Verdict unavailable');
    expect(page.entries.every((entry) => entry.source === 'trace')).toBe(true);
  });

  it('DoD-2 / VT-06 throws a payload-free unavailable error when both sources fail', async () => {
    await expect(
      getSessionTimeline(
        { sessionId: SESSION_ID, cursor: null },
        {
          loaders: loaders({
            agentError: new Error('SELECT * FROM agent_run_events'),
            traceError: new Error('SELECT * FROM trace_events'),
          }),
        },
      ),
    ).rejects.toMatchObject({ name: 'ObservabilityTimelineUnavailableError' });
  });

  it('DoD-2 / VT-07 keeps composite order stable across identical timestamps', async () => {
    const tiedAgent = agentEvent({
      eventId: 'aaa-agent',
      occurredAt: '2026-08-17T17:51:00.000Z',
      sequence: 1,
    });
    const tiedTrace = {
      id: 'bbb-trace',
      eventType: 'api_request' as const,
      occurredAt: '2026-08-17T17:51:00.000Z',
      actorId: null,
      projectId: null,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      sessionId: SESSION_ID,
      routeTemplate: '/api/projects',
      method: 'GET',
      statusCode: 200,
      durationMs: 1,
      severity: 'info',
      trigger: 'human' as const,
      diagnosticSummary: null,
    };
    const first = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      { loaders: loaders({ agent: [tiedAgent], traces: [tiedTrace] }) },
    );
    const second = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      { loaders: loaders({ agent: [tiedAgent], traces: [tiedTrace] }) },
    );
    expect(first.entries.map((entry) => entry.id)).toEqual(['aaa-agent', 'bbb-trace']);
    expect(second.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(compareSessionTimelineEntries(first.entries[0], first.entries[1])).toBeLessThan(0);
  });

  it('DoD-0 / VT-08 remains usable when the session has no Trace Event overlays', async () => {
    const page = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      { loaders: loaders({ traces: [] }) },
    );
    expect(page.sourceStatus.trace.state).toBe('empty');
    expect(page.sourceStatus.agent.state).toBe('complete');
    expect(page.partial).toBe(false);
    expect(page.entries.every((entry) => entry.source === 'agent')).toBe(true);
  });

  it('VT-09 pages 50 rows and hard-stops at the 500-row cap', async () => {
    const agent = Array.from({ length: 501 }, (_, index) =>
      agentEvent({
        eventId: `evt-${String(index).padStart(4, '0')}`,
        occurredAt: `2026-08-17T17:${String(Math.min(59, Math.floor(index / 10))).padStart(2, '0')}:00.000Z`,
        sequence: index,
        ordinal: index,
      }),
    );
    const first = await getSessionTimeline(
      { sessionId: SESSION_ID, cursor: null },
      { loaders: loaders({ agent, traces: [] }) },
    );
    expect(first.entries).toHaveLength(50);
    expect(first.page.nextCursor).toBeTruthy();
    expect(first.page.capReached).toBe(false);

    let cursor = first.page.nextCursor;
    let loaded = first.page.loaded;
    let pages = 1;
    const seen = new Set(first.entries.map((entry) => entry.id));
    while (cursor) {
      const next = await getSessionTimeline(
        {
          sessionId: SESSION_ID,
          cursor: {
            emittedCount: loaded,
            last: {
              occurredAt: nextOccurred(agent, loaded - 1),
              sourceRank: 0,
              sequence: loaded - 1,
              id: `evt-${String(loaded - 1).padStart(4, '0')}`,
            },
          },
        },
        { loaders: loaders({ agent, traces: [] }) },
      );
      for (const entry of next.entries) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      loaded = next.page.loaded;
      cursor = next.page.nextCursor;
      pages += 1;
      if (next.page.capReached) {
        expect(next.page.nextCursor).toBeNull();
        break;
      }
    }
    expect(loaded).toBe(500);
    expect(seen.size).toBe(500);
    expect(pages).toBe(10);
  });

  it('VT-13 strips candidate identity, concrete routes, tokens, tool args, errors, and stacks', () => {
    const agent = projectAgentEntry(
      agentEvent({
        detail: 'Bearer super-secret-token candidate@apex.test https://apex.local/users/99',
        toolName: 'edit',
      }),
    );
    const trace = projectTraceEntry({
      id: 'trace-unsafe',
      eventType: 'error',
      occurredAt: '2026-08-17T17:51:00.000Z',
      actorId: 'candidate-user',
      projectId: 'Apex',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      sessionId: SESSION_ID,
      routeTemplate: '/api/users/:id',
      method: 'GET',
      statusCode: 500,
      durationMs: 9,
      severity: 'error',
      trigger: 'human',
      diagnosticSummary: 'Authorization: Bearer abc.def.ghi stack: Error: boom\n    at run',
    });
    const serialized = JSON.stringify({ agent, trace });
    expect(serialized).toContain(TRACE_REDACTED_MARKER);
    expect(serialized).not.toMatch(/super-secret-token|candidate@apex\.test|\/users\/99|abc\.def\.ghi/);
    expect(agent?.details.every((detail) => detail.label !== 'args' && detail.label !== 'stack')).toBe(true);
    expect(trace?.routeTemplate).toBe('/api/users/:id');
    expect(trace).not.toHaveProperty('actorId');
  });

  it('returns a generic not-found contract for an unknown session', async () => {
    await expect(
      getSessionTimeline(
        { sessionId: SESSION_ID, cursor: null },
        { loaders: loaders({ identity: null }) },
      ),
    ).rejects.toBeInstanceOf(ObservabilityQueryError);
    await expect(
      getSessionTimeline(
        { sessionId: SESSION_ID, cursor: null },
        { loaders: loaders({ identity: null }) },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'OBSERVABILITY_NOT_FOUND' });
  });

  it('VT-20 verifies the session overlay query path is backed by the session/time index', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../db/schema.ts'), 'utf8');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/observabilitySessionTimeline.ts'),
      'utf8',
    );
    expect(schema).toMatch(/idx_trace_events_session_occurred/);
    expect(source).toMatch(/traceEvents\.sessionId/);
    expect(source).not.toMatch(/INSERT INTO agent_run_events|into\(traceEvents\)/);
  });
});

function nextOccurred(agent: DurableRunEventRow[], index: number): string {
  return agent[index]?.occurredAt ?? '2026-08-17T17:59:00.000Z';
}
