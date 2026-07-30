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
  validateGenerationProvenance,
  validateSteps,
  validateTargeting,
  validateTargetRules,
  WalkthroughDomainError,
  type WalkthroughStepInput,
} from '../../shared/types/walkthrough';
import {
  isWalkthroughRoute,
  listWalkthroughRoutes,
} from '../../shared/walkthroughRoutes';

describe('Walkthrough shared contracts (TBI-001)', () => {
  describe('DoD-2 — acknowledged is derived, not persisted', () => {
    it('deriveAcknowledged is true for completed and dismissed only', () => {
      expect(deriveAcknowledged('seen')).toBe(false);
      expect(deriveAcknowledged('completed')).toBe(true);
      expect(deriveAcknowledged('dismissed')).toBe(true);
    });

    it('rejects acknowledged as a stored status (DoD-2 / VT-04)', () => {
      expect(() => assertPersistedProgressStatus('acknowledged')).toThrow(
        WalkthroughDomainError
      );
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
      expect(() =>
        validateTargeting({ project: 'Apex', type: 'everyone' })
      ).toThrow(WalkthroughDomainError);
      expect(() =>
        validateTargeting({ project: 'Apex', userId: 'u-1' })
      ).toThrow(WalkthroughDomainError);
      expect(() =>
        validateTargetRules([
          { type: 'project', value: 'Apex' },
          { type: 'everyone', value: '*' },
        ])
      ).toThrow(/everyone|Unsupported/);
    });

    it('requires at least one project and allows multi-project; group only with a single project', () => {
      expect(() => validateTargetRules([])).toThrow(/At least one project/);
      expect(
        validateTargetRules([
          { type: 'project', value: 'A' },
          { type: 'project', value: 'B' },
        ])
      ).toEqual({ projects: ['A', 'B'], groupId: null });
      expect(validateTargeting({ project: 'Apex', groupId: 'grp-1' })).toEqual({
        projects: ['Apex'],
        groupId: 'grp-1',
      });
      expect(validateTargeting({ projects: ['Apex', 'Other'] })).toEqual({
        projects: ['Apex', 'Other'],
        groupId: null,
      });
      expect(() =>
        validateTargeting({ projects: ['Apex', 'Other'], groupId: 'grp-1' })
      ).toThrow(/group filter/i);
    });

    it('rejects incomplete / selector anchors; shape-valid unknown keys pass (catalog is separate)', () => {
      expect(validateAnchor(null)).toBeNull();
      expect(validateAnchor(undefined)).toBeNull();
      expect(() =>
        validateAnchor({ key: 'nav-help', targetRoute: '/help' })
      ).toThrow(/Incomplete anchor/);
      expect(() =>
        validateAnchor({
          key: '.css-selector',
          targetRoute: '/home',
          placement: 'bottom',
        })
      ).toThrow(/exact registry key|CSS selector/i);
      expect(
        validateAnchor({
          key: 'user-menu-trigger',
          targetRoute: '/home',
          placement: 'bottom',
        })
      ).toEqual({
        key: 'user-menu-trigger',
        targetRoute: '/home',
        placement: 'bottom',
      });
      expect(
        validateAnchor({
          key: 'nav-help',
          targetRoute: '/help',
          placement: 'bottom',
        })
      ).toEqual({
        key: 'nav-help',
        targetRoute: '/help',
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
        ])
      ).toThrow(/Duplicate Step ordinal/);
    });

    it('normalizes create command with targeting and steps', () => {
      const cmd = validateCreateCommand({
        internalName: 'feat-walkthrough',
        userTitle: 'Try Feature X',
        whyItMatters: 'Because it saves time',
        priority: 10,
        targeting: { projects: ['Apex'] },
        steps: [
          { ordinal: 1, heading: 'Second', bodyMarkdown: 'b' },
          { ordinal: 0, heading: 'First', bodyMarkdown: 'a' },
        ],
      });
      expect(cmd.steps.map((s: WalkthroughStepInput) => s.ordinal)).toEqual([
        0, 1,
      ]);
      expect(cmd.targeting.projects).toEqual(['Apex']);
    });
    it('normalizes multi-project targeting and rejects group with multiple projects', () => {
      const cmd = validateCreateCommand({
        internalName: 'multi',
        userTitle: 'Multi',
        whyItMatters: 'w',
        targeting: { projects: ['Apex', 'Other', 'Apex'] },
        steps: [{ ordinal: 0, heading: 'A', bodyMarkdown: 'a' }],
      });
      expect(cmd.targeting.projects).toEqual(['Apex', 'Other']);
    });

    it('derives anchored destinations and validates Step/CTA routes against the catalog', () => {
      const [step] = validateSteps([
        {
          ordinal: 0,
          heading: 'Profile',
          bodyMarkdown: 'Open your profile',
          imageUrl: '/brand-lockup.svg',
          imageAlt: 'Apex logo',
          ctaRoute: '/profile',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
          },
        },
      ]);
      expect(step.route).toBe('/home');
      expect(step.imageAlt).toBe('Apex logo');
      expect(() =>
        validateSteps([
          {
            ordinal: 0,
            heading: 'Invented',
            bodyMarkdown: 'No',
            route: '/profile/edit',
          },
        ])
      ).toThrow(/route catalog/i);
      expect(() =>
        validateSteps([
          {
            ordinal: 0,
            heading: 'Invented CTA',
            bodyMarkdown: 'No',
            ctaRoute: '/settings/privacy',
          },
        ])
      ).toThrow(/route catalog/i);
    });

    it('accepts a step with a valid route but no anchor (unanchored destination)', () => {
      const [step] = validateSteps([
        {
          ordinal: 0,
          heading: 'Profile page',
          bodyMarkdown: 'Visit your profile',
          route: '/profile',
        },
      ]);
      expect(step.route).toBe('/profile');
      expect(step.anchor).toBeNull();
    });

    it('rejects an anchored step whose anchor is missing placement', () => {
      expect(() =>
        validateSteps([
          {
            ordinal: 0,
            heading: 'Broken',
            bodyMarkdown: 'x',
            anchor: { key: 'user-menu-trigger', targetRoute: '/home' },
          },
        ])
      ).toThrow(/Incomplete anchor/);
    });
  });

  describe('Walkthrough route catalog and provenance', () => {
    it('exposes immutable, unique routes including Profile', () => {
      const routes = listWalkthroughRoutes();
      expect(Object.isFrozen(routes)).toBe(true);
      expect(new Set(routes.map((entry) => entry.route)).size).toBe(
        routes.length
      );
      expect(isWalkthroughRoute('/profile')).toBe(true);
      expect(isWalkthroughRoute('/backlog?tab=prds')).toBe(true);
      expect(isWalkthroughRoute('/profile/edit')).toBe(false);
    });

    it('normalizes valid Cursor provenance and rejects unsafe skill paths', () => {
      expect(
        validateGenerationProvenance({
          provider: 'cursor',
          model: 'composer-2.5',
          skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
          generatedAt: '2026-07-30T01:00:00Z',
          runId: 'run-1',
          threadId: 'thread-1',
        })
      ).toEqual({
        provider: 'cursor',
        model: 'composer-2.5',
        skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
        generatedAt: '2026-07-30T01:00:00.000Z',
        runId: 'run-1',
        threadId: 'thread-1',
      });
      expect(() =>
        validateGenerationProvenance({
          provider: 'cursor',
          model: 'composer-2.5',
          skillPath: '../outside/SKILL.md',
          generatedAt: '2026-07-30T01:00:00Z',
          runId: 'run-1',
        })
      ).toThrow(/skillPath/);
    });
  });
});
