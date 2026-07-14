import {
  APEX_ORIGIN_TAG,
  hasApexOriginTag,
  evaluateDevStartEligibility,
} from '../../shared/types/devWorkbench';

describe('hasApexOriginTag', () => {
  it('is true when the apex tag is present among other tags', () => {
    expect(hasApexOriginTag('needs-triage; apex; wave-2; FF_Foo')).toBe(true);
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(hasApexOriginTag('  Apex ; wave-1')).toBe(true);
    expect(hasApexOriginTag('APEX')).toBe(true);
  });

  it('is false when the apex tag is absent', () => {
    expect(hasApexOriginTag('wave-1; FF_Foo')).toBe(false);
  });

  it('is false for empty, null, or undefined tag strings', () => {
    expect(hasApexOriginTag('')).toBe(false);
    expect(hasApexOriginTag(null)).toBe(false);
    expect(hasApexOriginTag(undefined)).toBe(false);
  });

  it('does not match tags that merely contain "apex" as a substring', () => {
    expect(hasApexOriginTag('apex-adjacent; wave-1')).toBe(false);
  });

  it('exposes the canonical tag value', () => {
    expect(APEX_ORIGIN_TAG).toBe('apex');
  });
});

describe('evaluateDevStartEligibility', () => {
  const apexFeature = { workItemType: 'Feature', state: 'In Progress', tags: 'apex; wave-1' };

  describe('state gate (applies to everyone)', () => {
    it('blocks any item whose state is not startable, even for super admins', () => {
      const result = evaluateDevStartEligibility(
        { workItemType: 'Feature', state: 'In Pull Request', tags: 'apex' },
        { isSuperAdmin: true },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/only available for/i);
    });
  });

  describe('non-admin users', () => {
    it('allows APEX-generated Features in an allowed state', () => {
      expect(evaluateDevStartEligibility(apexFeature, { isSuperAdmin: false })).toEqual({ allowed: true });
    });

    it('blocks Features that lack the apex tag', () => {
      const result = evaluateDevStartEligibility(
        { workItemType: 'Feature', state: 'Committed', tags: 'wave-1; FF_Foo' },
        { isSuperAdmin: false },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/APEX-generated Features/i);
    });

    it('blocks non-Feature types even when tagged apex and in an allowed state', () => {
      for (const workItemType of ['Product Backlog Item', 'Technical Backlog Item', 'Bug']) {
        const result = evaluateDevStartEligibility(
          { workItemType, state: 'Active', tags: 'apex' },
          { isSuperAdmin: false },
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/only available on Features/i);
      }
    });
  });

  describe('super admins (platform admins)', () => {
    it('allows any work item type in an allowed state regardless of APEX origin', () => {
      for (const workItemType of ['Feature', 'Product Backlog Item', 'Technical Backlog Item', 'Bug']) {
        const result = evaluateDevStartEligibility(
          { workItemType, state: 'New', tags: '' },
          { isSuperAdmin: true },
        );
        expect(result).toEqual({ allowed: true });
      }
    });

    it('allows a non-APEX Feature', () => {
      expect(
        evaluateDevStartEligibility(
          { workItemType: 'Feature', state: 'Committed', tags: 'wave-1' },
          { isSuperAdmin: true },
        ),
      ).toEqual({ allowed: true });
    });
  });
});
