/**
 * TBI-008 DoD-2 and TBI-010 DoD-2 — the wrapper's surface, and the single gate behind it.
 *
 * The snapshot is inline on purpose. An external `.snap` file records a widened surface in a place
 * reviewers routinely skim past; inline, the new symbol lands in the same diff as the export that
 * introduced it, which is the review moment the definition of done is actually asking for.
 *
 * The runtime is mocked rather than exercised. Loading the real engine here would drag in Mastra
 * and a database connection to answer a question about the gate, and the engine's own behaviour is
 * proven against a live store in the integration suites instead.
 */
import { isFeatureEnabled } from '../services/featureFlagService';
import * as playbookEngine from '../services/playbookEngine';
import type { PlaybookGraph, PlaybookOperationContext } from '../../shared/types/playbook';

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

const startRunOnEngine = jest.fn().mockResolvedValue({ endedAs: 'completed' });
const resumeRunOnEngine = jest.fn().mockResolvedValue({ endedAs: 'completed' });
const cancelRunOnEngine = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/playbookEngine/runtime', () => ({
  startRunOnEngine: (...a: unknown[]) => startRunOnEngine(...a),
  resumeRunOnEngine: (...a: unknown[]) => resumeRunOnEngine(...a),
  cancelRunOnEngine: (...a: unknown[]) => cancelRunOnEngine(...a),
}));

const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;

const context: PlaybookOperationContext = {
  projectName: 'Apex',
  initiatorUserId: 'user-oid-1',
};

const graph: PlaybookGraph = {
  nodes: [{ id: 'step-1', stepType: 'notify' }],
  edges: [],
};

const engineInput = { ...context, runId: 'run-1', graph };

/** One call per operation, so "every operation is gated" is asserted rather than assumed. */
const everyOperation = (): Array<[string, () => Promise<unknown>]> => [
  ['start', () => playbookEngine.start({ ...engineInput, definitionVersionId: 'ver-1' })],
  ['resume', () => playbookEngine.resume({ ...engineInput, stepId: 'step-1', resolvedByUserId: 'user-oid-2' })],
  ['cancel', () => playbookEngine.cancel({ ...engineInput, cancelledByUserId: 'user-oid-2' })],
];

beforeEach(() => {
  mockIsFeatureEnabled.mockReset();
  startRunOnEngine.mockClear();
  resumeRunOnEngine.mockClear();
  cancelRunOnEngine.mockClear();
});

describe('TBI-008 — the wrapper exposes exactly the operations callers can use', () => {
  /*
   * DoD-2, VT-05.
   *
   * `suspend` left this list when the engine was actually wired. Phase 0 declared four operations
   * before anything ran; with a real engine behind it, suspension turns out not to be something a
   * caller can invoke — a step parks from inside its own body, when its adapter reports it is
   * waiting, and no outside code is ever in a position to do it. A narrowing belongs in this
   * snapshot every bit as much as a widening does.
   */
  it('matches the committed export snapshot', () => {
    expect(Object.keys(playbookEngine).sort()).toMatchInlineSnapshot(`
[
  "cancel",
  "resume",
  "start",
]
`);
  });

  // DoD-0 — every export is callable, so the snapshot is a surface and not a list of type aliases
  it('exposes each operation as a function', () => {
    for (const name of Object.keys(playbookEngine)) {
      expect(typeof (playbookEngine as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

describe('TBI-010 — the flag gates at a single top-level entry point', () => {
  // DoD-2
  it('refuses every operation when the flag is disabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    for (const [name, call] of everyOperation()) {
      await expect(call()).rejects.toThrow(/Playbooks are not enabled for project "Apex"/);
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        'playbooks-spike',
        expect.objectContaining({ userId: 'user-oid-1', project: 'Apex' })
      );
      expect(name).toBeTruthy();
    }
    expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(3);
  });

  // DoD-2 — the gate is passed, not merely present: the enabled path reaches the engine
  it('lets every operation through to the engine when the flag is enabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    for (const [, call] of everyOperation()) {
      await expect(call()).resolves.not.toThrow();
    }

    expect(startRunOnEngine).toHaveBeenCalledTimes(1);
    expect(resumeRunOnEngine).toHaveBeenCalledTimes(1);
    expect(cancelRunOnEngine).toHaveBeenCalledTimes(1);
  });

  // The engine is handed the pinned graph and Apex's run id, which is what lets any process resume
  it('passes the run id and the pinned graph through to the engine', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await playbookEngine.resume({ ...engineInput, stepId: 'step-1', resolvedByUserId: 'approver' });

    expect(resumeRunOnEngine).toHaveBeenCalledWith(
      graph,
      expect.objectContaining({ runId: 'run-1', project: 'Apex', initiatorUserId: 'user-oid-1' }),
      'step-1'
    );
  });

  /*
   * VT-13 — gated code merging before the seed migration lands must not enable anything.
   * `isFeatureEnabled` resolves an absent flag as disabled, and this asserts the wrapper relies on
   * that deliberately rather than by luck.
   */
  it('treats an absent flag as disabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false); // what the service returns for a missing flag
    await expect(
      playbookEngine.start({ ...engineInput, definitionVersionId: 'ver-1' })
    ).rejects.toThrow(/not enabled/);
    expect(startRunOnEngine).not.toHaveBeenCalled();
  });

  // The initiator is the identity the flag is evaluated against, per BR-003 — not the approver
  it('evaluates the flag against the run initiator, not the acting user', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    await expect(
      playbookEngine.resume({ ...engineInput, stepId: 'step-1', resolvedByUserId: 'approver-oid' })
    ).rejects.toThrow();

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      'playbooks-spike',
      expect.objectContaining({ userId: 'user-oid-1', project: 'Apex' })
    );
  });

  /*
   * Rule categories are ANDed when a flag is evaluated, so an environment rule compared against an
   * absent environment matches nothing and the flag is disabled everywhere. Phase 0 targets local
   * and dev by environment, which makes this the difference between a working demo and one that is
   * silently dark with the flag showing as on in Platform Admin.
   */
  it('passes the environment so environment targeting can match', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const originalAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'dev';

    try {
      await expect(
        playbookEngine.start({ ...engineInput, definitionVersionId: 'ver-1' })
      ).rejects.toThrow();
      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
        'playbooks-spike',
        expect.objectContaining({ environment: 'dev' })
      );
    } finally {
      if (originalAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = originalAppEnv;
    }
  });
});
