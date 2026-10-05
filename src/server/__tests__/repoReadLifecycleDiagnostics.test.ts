/**
 * @jest-environment node
 */

import { installLifecycleDiagnostics } from '../services/repoRead/entrypoint';

type Emitted = {
  name: string;
  properties?: Record<string, string>;
};

function harness() {
  const emitted: Emitted[] = [];
  const exits: number[] = [];
  let flushes = 0;

  installLifecycleDiagnostics({
    startedAt: Date.now() - 90_000,
    emit: (name, properties) => {
      emitted.push({ name, properties });
    },
    flush: async () => {
      flushes += 1;
    },
    exit: (code) => {
      exits.push(code);
    },
    inFlight: () => 2,
    rssBytes: () => 700 * 1_048_576,
  });

  return {
    emitted,
    exits,
    flushCount: () => flushes,
  };
}

// process.emit is typed for signals, so lifecycle events need the emitter view.
const emitter = process as NodeJS.EventEmitter;

// The handlers report asynchronously so the flush can complete before exit.
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('repo-read lifecycle diagnostics', () => {
  const signals = [
    'SIGTERM',
    'SIGINT',
    'uncaughtException',
    'unhandledRejection',
  ] as const;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    for (const signal of signals) {
      process.removeAllListeners(signal);
    }
  });

  it('attributes a probe-driven stop to the platform rather than a crash', async () => {
    const { emitted, exits } = harness();

    emitter.emit('SIGTERM');
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].name).toBe('RepoReadServiceExit');
    expect(emitted[0].properties?.reason).toBe('SIGTERM');
    // Distinguishing a probe kill from an OOM needs the memory reading the
    // platform's per-minute sampling would have missed.
    expect(emitted[0].properties?.rssMb).toBe('700');
    expect(emitted[0].properties?.inFlightHydrations).toBe('2');
    expect(emitted[0].properties?.uptimeSeconds).toBe('90');
    expect(exits).toEqual([0]);
  });

  it('flushes before exiting, since a batched exit event is a lost one', async () => {
    const { exits, flushCount } = harness();

    emitter.emit('SIGTERM');
    await settle();

    expect(flushCount()).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('separates a self-inflicted death from a platform stop', async () => {
    const { emitted, exits } = harness();

    emitter.emit('uncaughtException', new TypeError('reader exploded'));
    await settle();

    expect(emitted[0].properties?.reason).toBe('uncaughtException');
    expect(emitted[0].properties?.errorName).toBe('TypeError');
    expect(emitted[0].properties?.errorMessage).toBe('reader exploded');
    expect(exits).toEqual([1]);
  });

  it('strips the PAT out of a git error before it reaches telemetry', async () => {
    const { emitted } = harness();

    emitter.emit(
      'uncaughtException',
      new Error(
        "fatal: could not read from 'https://user:ghp_supersecret@dev.azure.com/org/_git/repo'"
      )
    );
    await settle();

    const message = emitted[0].properties?.errorMessage ?? '';
    expect(message).not.toContain('ghp_supersecret');
    expect(message).toContain('//***@dev.azure.com');
  });

  it('reports an unhandled rejection that carries no Error', async () => {
    const { emitted, exits } = harness();

    emitter.emit('unhandledRejection', 'mirror vanished');
    await settle();

    expect(emitted[0].properties?.reason).toBe('unhandledRejection');
    expect(emitted[0].properties?.errorName).toBe('string');
    expect(emitted[0].properties?.errorMessage).toBe('mirror vanished');
    expect(exits).toEqual([1]);
  });
});
