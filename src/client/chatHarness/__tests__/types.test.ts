import { HARNESS_AREA_IDS } from '../../../shared/types/chatHarness';
import {
  formatHarnessReceipt,
  isSignInRequiredReason,
  normalizeReceiptReason,
} from '../types';
import {
  FIXTURE_CMD_ID_1,
  makeRunningTurnFrames,
  makeSnapshot,
} from './fixtures';

describe('S1 chatHarness types and receipt formatter', () => {
  it('supports all 12 governed harness areas (excluding ui-lab)', () => {
    expect(HARNESS_AREA_IDS).toHaveLength(12);
    expect(HARNESS_AREA_IDS).not.toContain('ui-lab');
  });

  it('formats steer applied, accepted, queued, and rejected receipts to design-spec copy', () => {
    expect(
      formatHarnessReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'applied',
      }),
    ).toEqual(
      expect.objectContaining({
        text: 'Steer sent',
        autoDismissMs: 5000,
        tone: 'info',
      }),
    );

    expect(
      formatHarnessReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'accepted',
        reason: 'summarizing',
      }),
    ).toEqual(
      expect.objectContaining({
        text: 'Steer received',
        autoDismissMs: null,
      }),
    );

    expect(
      formatHarnessReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'queued',
        reason: 'turn_ended',
      }),
    ).toEqual(
      expect.objectContaining({
        text: 'Turn had finished, sent as a new message',
        autoDismissMs: 5000,
      }),
    );

    expect(
      formatHarnessReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'queued',
        reason: 'queued_behind_turn',
      }),
    ).toEqual(
      expect.objectContaining({
        text: 'Queued as follow-up',
        autoDismissMs: 5000,
      }),
    );

    expect(
      formatHarnessReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'rejected',
        reason: 'steer_cap',
      }),
    ).toEqual(
      expect.objectContaining({
        text: 'Wait for this step to finish',
        autoDismissMs: null,
        tone: 'error',
      }),
    );

    expect(
      formatHarnessReceipt({
        commandId: FIXTURE_CMD_ID_1,
        kind: 'steer',
        status: 'rejected',
        reason: 'no_write_access',
      }),
    ).toEqual(
      expect.objectContaining({
        text: 'You have read-only access to this thread.',
        autoDismissMs: null,
        tone: 'error',
      }),
    );
  });

  it('identifies sign_in_required across code alias and server string', () => {
    expect(isSignInRequiredReason('sign_in_required')).toBe(true);
    expect(isSignInRequiredReason('Sign in again to continue')).toBe(true);
    expect(isSignInRequiredReason('steer_cap')).toBe(false);
    expect(normalizeReceiptReason('You have read-only access to this chat')).toBe(
      'You have read-only access to this thread.',
    );
  });

  it('builds valid snapshot and running-turn frame fixtures', () => {
    const snap = makeSnapshot();
    expect(snap.state.harnessArea).toBe('agent-home');
    const frames = makeRunningTurnFrames('brainstorm');
    expect(frames.length).toBeGreaterThanOrEqual(5);
  });
});
