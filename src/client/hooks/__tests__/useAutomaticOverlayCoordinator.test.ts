/**
 * FEAT-005 / PBI-005 — useAutomaticOverlayCoordinator
 * AC-1, AC-2, BR-005, BR-006
 */
import { act, renderHook } from '@testing-library/react';
import type { WalkthroughDefinition } from '../../../shared/types/walkthrough';
import { useAutomaticOverlayCoordinator } from '../useAutomaticOverlayCoordinator';

const trackEvent = jest.fn();
jest.mock('../../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

const sample: WalkthroughDefinition = {
  id: 'wt-1',
  internalName: 'intro',
  userTitle: 'Intro',
  whyItMatters: 'Why',
  lifecycle: 'published',
  priority: 10,
  isRequired: false,
  revision: 1,
  publishedAt: '2026-07-02T00:00:00Z',
  archivedAt: null,
  createdBy: 'admin',
  createdAt: '2026-07-01T00:00:00Z',
  updatedBy: 'admin',
  updatedAt: '2026-07-01T00:00:00Z',
  steps: [],
  targeting: { projects: ['Apex'], groupId: null },
  targetingRules: [{ type: 'project', value: 'Apex' }],
};

beforeEach(() => {
  trackEvent.mockReset();
});

describe('useAutomaticOverlayCoordinator (PBI-005)', () => {
  it('AC-0: launches the eligible candidate when Whats New is settled and not opening', () => {
    const { result } = renderHook(() =>
      useAutomaticOverlayCoordinator({
        whatsNewSettled: true,
        whatsNewBlocksWalkthrough: false,
        eligibilitySettled: true,
        eligibilityError: false,
        candidate: sample,
      }),
    );

    expect(result.current.decision).toEqual({ status: 'launch', walkthrough: sample });
    expect(result.current.activeWalkthrough?.id).toBe('wt-1');
    expect(trackEvent).toHaveBeenCalledWith(
      'walkthrough.auto_launched',
      expect.objectContaining({ walkthroughId: 'wt-1' }),
    );
  });

  it('AC-1: eligibility error suppresses launch and leaves no active Walkthrough', () => {
    const { result } = renderHook(() =>
      useAutomaticOverlayCoordinator({
        whatsNewSettled: true,
        whatsNewBlocksWalkthrough: false,
        eligibilitySettled: true,
        eligibilityError: true,
        candidate: null,
      }),
    );

    expect(result.current.decision).toEqual({
      status: 'suppressed',
      reason: 'eligibility_error',
    });
    expect(result.current.activeWalkthrough).toBeNull();
  });

  it('AC-2 / BR-006: Whats New precedence suppresses Walkthrough for this load', () => {
    const { result } = renderHook(() =>
      useAutomaticOverlayCoordinator({
        whatsNewSettled: true,
        whatsNewBlocksWalkthrough: true,
        eligibilitySettled: true,
        eligibilityError: false,
        candidate: sample,
      }),
    );

    expect(result.current.decision).toEqual({ status: 'suppressed', reason: 'whats_new' });
    expect(result.current.activeWalkthrough).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith(
      'walkthrough.auto_launch_suppressed',
      expect.objectContaining({ reason: 'whats_new' }),
    );
  });

  it('BR-005: candidate change after decision does not launch a second Walkthrough', () => {
    const other: WalkthroughDefinition = { ...sample, id: 'wt-2', priority: 99 };
    const { result, rerender } = renderHook(
      (props: {
        candidate: WalkthroughDefinition | null;
        whatsNewBlocksWalkthrough: boolean;
      }) =>
        useAutomaticOverlayCoordinator({
          whatsNewSettled: true,
          whatsNewBlocksWalkthrough: props.whatsNewBlocksWalkthrough,
          eligibilitySettled: true,
          eligibilityError: false,
          candidate: props.candidate,
        }),
      { initialProps: { candidate: sample, whatsNewBlocksWalkthrough: false } },
    );

    expect(result.current.activeWalkthrough?.id).toBe('wt-1');

    act(() => {
      result.current.clearActiveWalkthrough();
    });
    expect(result.current.activeWalkthrough).toBeNull();

    rerender({ candidate: other, whatsNewBlocksWalkthrough: false });
    expect(result.current.activeWalkthrough).toBeNull();
    expect(result.current.decision.status).toBe('launch');
  });

  it('waits while Whats New or eligibility is unsettled', () => {
    const { result, rerender } = renderHook(
      (props: { whatsNewSettled: boolean; eligibilitySettled: boolean }) =>
        useAutomaticOverlayCoordinator({
          whatsNewSettled: props.whatsNewSettled,
          whatsNewBlocksWalkthrough: false,
          eligibilitySettled: props.eligibilitySettled,
          eligibilityError: false,
          candidate: sample,
        }),
      { initialProps: { whatsNewSettled: false, eligibilitySettled: true } },
    );

    expect(result.current.decision).toEqual({ status: 'pending' });
    expect(result.current.activeWalkthrough).toBeNull();

    rerender({ whatsNewSettled: true, eligibilitySettled: true });
    expect(result.current.decision.status).toBe('launch');
  });
});
