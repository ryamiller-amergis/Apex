/**
 * TBI-001 DoD / VT-04 — shared Walkthrough contract validators.
 * Criterion ids in describe/test names for matrix traceability.
 */

import {
  assertPersistedProgressStatus,
  canTransitionLifecycle,
  deriveAcknowledged,
  validateAnchor,
  validateCreateCommand,
  validateSteps,
  validateTargeting,
  validateTargetRules,
  WalkthroughDomainError,
  type WalkthroughStepInput,
} from '../../shared/types/walkthrough';

describe('Walkthrough shared contracts (TBI-001)', () => {
  describe('DoD-2 — acknowledged is derived, not persisted', () => {
    it('deriveAcknowledged is true for completed and dismissed only', () => {
      expect(deriveAcknowledged('seen')).toBe(false);
      expect(deriveAcknowledged('completed')).toBe(true);
      expect(deriveAcknowledged('dismissed')).toBe(true);
    });

    it('rejects acknowledged as a stored status (DoD-2 / VT-04)', () => {
      expect(() => assertPersistedProgressStatus('acknowledged')).toThrow(WalkthroughDomainError);
      try {
        assertPersistedProgressStatus('acknowledged');
      } catch (err) {
        expect(err).toBeInstanceOf(WalkthroughDomainError);
        expect((err as WalkthroughDomainError).code).toBe('INVALID_PROGRESS');
      }
    });

    it('accepts seen, completed, dismissed', () => {
      expect(assertPersistedProgressStatus('seen')).toBe('seen');
      expect(assertPersistedProgressStatus('completed')).toBe('completed');
      expect(assertPersistedProgressStatus('dismissed')).toBe('dismissed');
    });
  });

  describe('DoD-1 — lifecycle, targeting, progress, nullable anchor models', () => {
    it('lifecycle transition matrix allows draft→published and blocks archived→published', () => {
      expect(canTransitionLifecycle('draft', 'published')).toBe(true);
      expect(canTransitionLifecycle('published', 'unpublished')).toBe(true);
      expect(canTransitionLifecycle('published', 'archived')).toBe(true);
      expect(canTransitionLifecycle('archived', 'published')).toBe(false);
      expect(canTransitionLifecycle('draft', 'unpublished')).toBe(false);
    });

    it('rejects everyone and user targeting (VT-04)', () => {
      expect(() => validateTargeting({ project: 'Apex', type: 'everyone' })).toThrow(
        WalkthroughDomainError,
      );
      expect(() => validateTargeting({ project: 'Apex', userId: 'u-1' })).toThrow(
        WalkthroughDomainError,
      );
      expect(() =>
        validateTargetRules([
          { type: 'project', value: 'Apex' },
          { type: 'everyone', value: '*' },
        ]),
      ).toThrow(/everyone|Unsupported/);
    });

    it('requires exactly one project and at most one group', () => {
      expect(() => validateTargetRules([])).toThrow(/Exactly one project/);
      expect(() =>
        validateTargetRules([
          { type: 'project', value: 'A' },
          { type: 'project', value: 'B' },
        ]),
      ).toThrow(/Exactly one project/);
      expect(
        validateTargeting({ project: 'Apex', groupId: 'grp-1' }),
      ).toEqual({ project: 'Apex', groupId: 'grp-1' });
    });

    it('rejects incomplete anchor tuples and accepts registered full or null (DoD-3 / VT-04)', () => {
      expect(validateAnchor(null)).toBeNull();
      expect(validateAnchor(undefined)).toBeNull();
      expect(() =>
        validateAnchor({ key: 'nav-help', targetRoute: '/help' }),
      ).toThrow(/Incomplete anchor/);
      expect(() =>
        validateAnchor({
          key: 'nav-help',
          targetRoute: '/help',
          placement: 'bottom',
        }),
      ).toThrow(/Unregistered|unregistered/i);
      expect(
        validateAnchor({
          key: 'user-menu-trigger',
          targetRoute: '/home',
          placement: 'bottom',
        }),
      ).toEqual({
        key: 'user-menu-trigger',
        targetRoute: '/home',
        placement: 'bottom',
      });
    });
  });

  describe('DoD-0/DoD-1 — step ordering and create command', () => {
    it('rejects duplicate ordinals before persistence (VT-04)', () => {
      expect(() =>
        validateSteps([
          { ordinal: 0, heading: 'A', bodyMarkdown: 'a' },
          { ordinal: 0, heading: 'B', bodyMarkdown: 'b' },
        ]),
      ).toThrow(/Duplicate Step ordinal/);
    });

    it('normalizes create command with targeting and steps', () => {
      const cmd = validateCreateCommand({
        internalName: 'feat-walkthrough',
        userTitle: 'Try Feature X',
        whyItMatters: 'Because it saves time',
        priority: 10,
        targeting: { project: 'Apex' },
        steps: [
          { ordinal: 1, heading: 'Second', bodyMarkdown: 'b' },
          { ordinal: 0, heading: 'First', bodyMarkdown: 'a' },
        ],
      });
      expect(cmd.steps.map((s: WalkthroughStepInput) => s.ordinal)).toEqual([0, 1]);
      expect(cmd.targeting.project).toBe('Apex');
    });
  });
});
