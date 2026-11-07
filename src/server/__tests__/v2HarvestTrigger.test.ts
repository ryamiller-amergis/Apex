import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import { NonblockingRepoCacheLeaseUnavailableError } from '../services/repoCacheLeaseService';
import { createV2HarvestTrigger, isRunEndedEvent } from '../services/v2HarvestTrigger';

function envelope(overrides: Partial<AgentRunEventEnvelope> = {}): AgentRunEventEnvelope {
  return {
    eventId: 'event-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sourceInstance: 'orchestrator',
    sequence: 1,
    timestamp: '2026-11-04T00:00:00.000Z',
    type: 'done',
    phase: 'completion',
    status: 'completed',
    event: { type: 'done', runId: 'run-1' },
    ...overrides,
  } as AgentRunEventEnvelope;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('v2HarvestTrigger', () => {
  it('treats only terminal done events as a run ending', () => {
    expect(isRunEndedEvent(envelope())).toBe(true);
    expect(isRunEndedEvent(envelope({ status: 'failed' }))).toBe(true);
    expect(isRunEndedEvent(envelope({ type: 'token' } as Partial<AgentRunEventEnvelope>))).toBe(false);
    expect(isRunEndedEvent(envelope({ status: 'running' } as Partial<AgentRunEventEnvelope>))).toBe(false);
  });

  it('harvests documents and prototypes under the lease when a run ends', async () => {
    let listener: ((event: AgentRunEventEnvelope) => void) | null = null;
    const harvestDocuments = jest.fn().mockResolvedValue(1);
    const harvestPrototypes = jest.fn().mockResolvedValue(0);
    const withLease = jest.fn().mockImplementation((operation: () => Promise<unknown>) => operation());
    const trigger = createV2HarvestTrigger({
      harvestDocuments,
      harvestPrototypes,
      withLease,
      subscribe: (callback) => {
        listener = callback;
        return () => { listener = null; };
      },
    });

    trigger.start();
    listener!(envelope({ type: 'token' } as Partial<AgentRunEventEnvelope>));
    await flush();
    expect(withLease).not.toHaveBeenCalled();

    listener!(envelope());
    await flush();
    expect(withLease).toHaveBeenCalledTimes(1);
    expect(harvestDocuments).toHaveBeenCalledTimes(1);
    expect(harvestPrototypes).toHaveBeenCalledTimes(1);

    trigger.stop();
    expect(listener).toBeNull();
  });

  it('runs once more when a run ends during a harvest', async () => {
    let release: () => void = () => undefined;
    const harvestDocuments = jest
      .fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => {
        release = () => resolve(0);
      }))
      .mockResolvedValue(0);
    const trigger = createV2HarvestTrigger({
      harvestDocuments,
      harvestPrototypes: jest.fn().mockResolvedValue(0),
      withLease: (operation) => operation(),
      subscribe: () => () => undefined,
    });

    trigger.request();
    trigger.request();
    trigger.request();
    await flush();
    expect(harvestDocuments).toHaveBeenCalledTimes(1);

    release();
    await flush();
    await flush();
    expect(harvestDocuments).toHaveBeenCalledTimes(2);
  });

  it('retries shortly when another process holds the lease', async () => {
    const timers: Array<() => void> = [];
    const harvestDocuments = jest.fn().mockResolvedValue(0);
    const withLease = jest
      .fn()
      .mockRejectedValueOnce(new NonblockingRepoCacheLeaseUnavailableError('ai-run-v2-harvest'))
      .mockImplementation((operation: () => Promise<unknown>) => operation());
    const trigger = createV2HarvestTrigger({
      harvestDocuments,
      harvestPrototypes: jest.fn().mockResolvedValue(0),
      withLease,
      subscribe: () => () => undefined,
      setTimer: (callback) => { timers.push(callback); },
    });

    trigger.request();
    await flush();
    expect(harvestDocuments).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);

    timers[0]();
    await flush();
    expect(harvestDocuments).toHaveBeenCalledTimes(1);
  });
});
