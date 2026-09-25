/**
 * TBI-008 DoD-2 — the wrapper's surface and delegation to the runtime.
 *
 * The snapshot is inline on purpose. An external `.snap` file records a widened surface in a place
 * reviewers routinely skim past; inline, the new symbol lands in the same diff as the export that
 * introduced it, which is the review moment the definition of done is actually asking for.
 *
 * The runtime is mocked rather than exercised. Loading the real engine here would drag in Mastra
 * and a database connection to answer a question about the gate, and the engine's own behaviour is
 * proven against a live store in the integration suites instead.
 */
import * as playbookEngine from '../services/playbookEngine';
import type { PlaybookGraph, PlaybookOperationContext } from '../../shared/types/playbook';

const startRunOnEngine = jest.fn().mockResolvedValue({ endedAs: 'completed' });
const resumeRunOnEngine = jest.fn().mockResolvedValue({ endedAs: 'completed' });
const cancelRunOnEngine = jest.fn().mockResolvedValue(undefined);
const retryStepRunOnEngine = jest.fn().mockResolvedValue({ endedAs: 'completed' });

jest.mock('../services/playbookEngine/runtime', () => ({
  startRunOnEngine: (...a: unknown[]) => startRunOnEngine(...a),
  resumeRunOnEngine: (...a: unknown[]) => resumeRunOnEngine(...a),
  cancelRunOnEngine: (...a: unknown[]) => cancelRunOnEngine(...a),
  retryStepRunOnEngine: (...a: unknown[]) => retryStepRunOnEngine(...a),
}));

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
  ['retry', () => playbookEngine.retry({
    ...engineInput,
    definitionVersionId: 'ver-1',
    stepRunId: 'step-run-1',
    stepId: 'step-1',
    retriedByUserId: 'user-oid-2',
  })],
];

beforeEach(() => {
  startRunOnEngine.mockClear();
  resumeRunOnEngine.mockClear();
  cancelRunOnEngine.mockClear();
  retryStepRunOnEngine.mockClear();
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
  "retry",
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

describe('TBI-008 — operations delegate to the runtime', () => {
  it('reaches the runtime for every operation', async () => {
    for (const [, call] of everyOperation()) {
      await expect(call()).resolves.not.toThrow();
    }

    expect(startRunOnEngine).toHaveBeenCalledTimes(1);
    expect(resumeRunOnEngine).toHaveBeenCalledTimes(1);
    expect(cancelRunOnEngine).toHaveBeenCalledTimes(1);
    expect(retryStepRunOnEngine).toHaveBeenCalledTimes(1);
  });

  // The engine is handed the pinned graph and Apex's run id, which is what lets any process resume
  it('passes the run id and the pinned graph through to the engine', async () => {
    await playbookEngine.resume({ ...engineInput, stepId: 'step-1', resolvedByUserId: 'approver' });

    expect(resumeRunOnEngine).toHaveBeenCalledWith(
      graph,
      expect.objectContaining({ runId: 'run-1', project: 'Apex', initiatorUserId: 'user-oid-1' }),
      'step-1'
    );
  });
});
