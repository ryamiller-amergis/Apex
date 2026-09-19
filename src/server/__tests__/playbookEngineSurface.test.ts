/**
 * TBI-008 DoD-2 and TBI-010 DoD-2 — the wrapper's surface, and the single gate behind it.
 *
 * The snapshot is inline on purpose. An external `.snap` file records a widened surface in a place
 * reviewers routinely skim past; inline, the new symbol lands in the same diff as the export that
 * introduced it, which is the review moment the definition of done is actually asking for.
 */
import { isFeatureEnabled } from '../services/featureFlagService';
import * as playbookEngine from '../services/playbookEngine';
import type { PlaybookOperationContext } from '../../shared/types/playbook';

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;

const context: PlaybookOperationContext = {
  projectName: 'Apex',
  initiatorUserId: 'user-oid-1',
};

/** One call per operation, so "every operation is gated" is asserted rather than assumed. */
const everyOperation = (): Array<[string, () => Promise<unknown>]> => [
  ['start', () => playbookEngine.start({ ...context, definitionVersionId: 'ver-1' })],
  ['suspend', () => playbookEngine.suspend({ ...context, runId: 'run-1', stepId: 'step-1', reason: 'approval_gate', deadline: '2026-10-01T00:00:00.000Z' })],
  ['resume', () => playbookEngine.resume({ ...context, runId: 'run-1', stepId: 'step-1', resolvedByUserId: 'user-oid-2' })],
  ['cancel', () => playbookEngine.cancel({ ...context, runId: 'run-1', cancelledByUserId: 'user-oid-2' })],
];

beforeEach(() => {
  mockIsFeatureEnabled.mockReset();
});

describe('TBI-008 — the wrapper exposes exactly four operations', () => {
  // DoD-2, VT-05
  it('matches the committed export snapshot', () => {
    expect(Object.keys(playbookEngine).sort()).toMatchInlineSnapshot(`
[
  "cancel",
  "resume",
  "start",
  "suspend",
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
    expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(4);
  });

  // DoD-2 — the gate is passed, not merely present: the enabled path gets further
  it('lets every operation past the gate when the flag is enabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    for (const [, call] of everyOperation()) {
      await expect(call()).rejects.toThrow(/has no engine behind it yet/);
    }
    expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(4);
  });

  /*
   * VT-13 — gated code merging before the seed migration lands must not enable anything.
   * `isFeatureEnabled` resolves an absent flag as disabled, and this asserts the wrapper relies on
   * that deliberately rather than by luck.
   */
  it('treats an absent flag as disabled', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false); // what the service returns for a missing flag
    await expect(playbookEngine.start({ ...context, definitionVersionId: 'ver-1' })).rejects.toThrow(
      /not enabled/
    );
  });

  // The initiator is the identity the flag is evaluated against, per BR-003 — not the approver
  it('evaluates the flag against the run initiator, not the acting user', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    await expect(
      playbookEngine.resume({ ...context, runId: 'run-1', stepId: 'step-1', resolvedByUserId: 'approver-oid' })
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
      await expect(playbookEngine.start({ ...context, definitionVersionId: 'ver-1' })).rejects.toThrow();
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
