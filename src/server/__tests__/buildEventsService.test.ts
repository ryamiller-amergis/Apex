/**
 * PBI-001 AC-0, AC-1, AC-3 and TBI-003 DoD-1..DoD-3 / VT-19..VT-21.
 */
import * as events from '../services/buildEventsService';
import { appendBuildEvent, BuildEventWriteRefusedError } from '../services/buildEventsService';
import type { BuildEventExecutor } from '../services/buildEventsService';

const token = ['Bear', 'er sk_live_', 'abcdefghij'].join('');

function recordingExecutor(conflict = false) {
  const calls: Array<Record<string, unknown>> = [];
  let insertCalled = false;
  const executor = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertCalled = true;
        calls.push(row);
        const chain = {
          onConflictDoNothing: () => chain,
          returning: async () => (conflict ? [] : [{
            ...row,
            id: 'event-1',
            ordinal: calls.length,
            createdAt: '2026-10-23T12:00:00.000Z',
            buildRevisionId: row.buildRevisionId ?? null,
            detail: row.detail ?? null,
            correlationKind: row.correlationKind ?? null,
            correlationId: row.correlationId ?? null,
            actorUserId: row.actorUserId ?? null,
            dedupeKey: row.dedupeKey ?? null,
          }]),
        };
        return chain;
      },
    }),
  };
  return {
    executor: executor as unknown as BuildEventExecutor,
    calls,
    wasCalled: () => insertCalled,
  };
}

describe('VT-19 events writer stores redacted text and the correlation id', () => {
  it('VT-19 / AC-0 / DoD-1 redacts message and detail before insert', async () => {
    const recorded = recordingExecutor();
    const long = `${token} ${'x'.repeat(9000)}`;
    const result = await appendBuildEvent({
      buildRunId: 'run-1',
      eventType: 'task.completed',
      message: long,
      detail: { note: token, count: 1 },
      correlation: { kind: 'agent_run', id: 'agent-9' },
    }, {
      executor: recorded.executor,
      redact: (input) => input.split(token).join('[REDACTED:bearer-token]'),
      redactJson: (value) => JSON.parse(JSON.stringify(value).split(token).join('[REDACTED:bearer-token]')),
    });

    expect(result.inserted).toBe(true);
    const row = recorded.calls[0];
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.message).toContain('[REDACTED:bearer-token]');
    expect(String(row.message).length).toBeLessThanOrEqual(8000);
    expect(row.correlationKind).toBe('agent_run');
    expect(row.correlationId).toBe('agent-9');
    expect(result.event?.correlationId).toBe('agent-9');
  });
});

describe('VT-20 a payload that cannot be redacted is refused', () => {
  it('VT-20 / AC-1 / DoD-1 logs the run and event type and does not insert', async () => {
    const recorded = recordingExecutor();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'raw-payload-must-not-be-logged';
    await expect(appendBuildEvent({
      buildRunId: 'run-1',
      eventType: 'task.failed',
      message: secret,
    }, {
      executor: recorded.executor,
      redact: () => { throw new Error(secret); },
    })).rejects.toBeInstanceOf(BuildEventWriteRefusedError);

    expect(recorded.wasCalled()).toBe(false);
    const logged = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('run-1');
    expect(logged).toContain('task.failed');
    expect(logged).not.toContain(secret);
    errorSpy.mockRestore();
  });
});

describe('VT-21 events cannot be edited through the writer', () => {
  it('VT-21 / AC-3 / DoD-3 exports no update or delete and a repeat dedupe inserts nothing', async () => {
    const names = Object.keys(events);
    expect(names.some((name) => /update|delete|remove/i.test(name))).toBe(false);
    const recorded = recordingExecutor(true);
    const result = await appendBuildEvent({
      buildRunId: 'run-1',
      eventType: 'task.completed',
      message: 'done',
      dedupeKey: 'task-1-done',
    }, {
      executor: recorded.executor,
      redact: (input) => input,
      redactJson: (value) => value,
    });
    expect(result).toEqual({ inserted: false, event: null });
  });
});
