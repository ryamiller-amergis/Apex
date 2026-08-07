import {
  resolveProjectAssignment,
  seedProjectPicksFromRelease,
} from '../../shared/foundationSkillProjectAssignment';
import { collectFoundationSkillValidationIssues } from '../../shared/foundationSkillDependencies';
import type { FoundationSkillCatalogEntry } from '../../shared/types/foundationSkills';

const catalog: FoundationSkillCatalogEntry[] = [
  { name: 'prd-spec-review', summary: 'Review PRDs.', tier: 'shippable', dependsOn: ['to-prd'] },
  {
    name: 'design-spec-review',
    summary: 'Review design specs.',
    tier: 'shippable',
    dependsOn: ['prd-design-spec', 'to-prd'],
  },
  { name: 'to-prd', summary: 'Generate PRDs.', tier: 'shippable', dependsOn: [] },
  {
    name: 'prd-design-spec',
    summary: 'Generate design specs.',
    tier: 'shippable',
    dependsOn: ['to-prd'],
  },
  {
    name: 'feature-request-analysis',
    summary: 'Analyze feature requests.',
    tier: 'shippable',
    dependsOn: [],
  },
];

describe('resolveProjectAssignment', () => {
  it('auto-adds transitive dependencies to the project that needs them', () => {
    const result = resolveProjectAssignment(
      catalog,
      ['MaxView', 'MatterWorx'],
      {
        MaxView: ['design-spec-review'],
        MatterWorx: ['feature-request-analysis'],
      },
    );

    expect(result.perProject.MaxView.effective).toEqual([
      'design-spec-review',
      'to-prd',
      'prd-design-spec',
    ]);
    expect(result.perProject.MatterWorx.effective).toEqual(['feature-request-analysis']);
    expect(result.skillTargets['to-prd']).toEqual(['MaxView']);
    expect(result.skillTargets['prd-design-spec']).toEqual(['MaxView']);
    expect(result.skillTargets['design-spec-review']).toEqual(['MaxView']);
    expect(result.skillTargets['feature-request-analysis']).toEqual(['MatterWorx']);
    expect(result.dependencyOrder).toEqual([
      'to-prd',
      'prd-design-spec',
      'design-spec-review',
      'feature-request-analysis',
    ]);
  });

  it('omits skillTargets when a skill is assigned to every selected project', () => {
    const result = resolveProjectAssignment(
      catalog,
      ['MaxView', 'MatterWorx'],
      {
        MaxView: ['to-prd', 'feature-request-analysis'],
        MatterWorx: ['to-prd'],
      },
    );

    expect(result.skillTargets['to-prd']).toBeUndefined();
    expect(result.skillTargets['feature-request-analysis']).toEqual(['MaxView']);
    expect(result.targetProjects).toEqual(['MaxView', 'MatterWorx']);
  });

  it('produces a MaxView / MatterWorx split without audience_gap validation issues', () => {
    const result = resolveProjectAssignment(
      catalog,
      ['MaxView', 'MatterWorx'],
      {
        MaxView: ['prd-spec-review'],
        MatterWorx: ['design-spec-review'],
      },
    );

    expect(result.skillTargets['prd-spec-review']).toEqual(['MaxView']);
    expect(result.skillTargets['design-spec-review']).toEqual(['MatterWorx']);
    // to-prd is required by both projects → inherits release default (omitted)
    expect(result.skillTargets['to-prd']).toBeUndefined();
    expect(result.skillTargets['prd-design-spec']).toEqual(['MatterWorx']);

    const issues = collectFoundationSkillValidationIssues({
      skills: catalog,
      selectedSkills: result.effectiveSelectedSkills,
      targetProjects: result.targetProjects,
      skillTargets: result.skillTargets,
    });
    expect(issues).toEqual([]);
  });

  it('returns empty selection when no projects are provided', () => {
    const result = resolveProjectAssignment(catalog, [], { MaxView: ['to-prd'] });
    expect(result.effectiveSelectedSkills).toEqual([]);
    expect(result.dependencyOrder).toEqual([]);
    expect(result.skillTargets).toEqual({});
    expect(result.perProject).toEqual({});
  });
});

describe('seedProjectPicksFromRelease', () => {
  it('inverts skillTargets into per-project picks and round-trips', () => {
    const seeded = seedProjectPicksFromRelease({
      selectedSkills: [
        'to-prd',
        'prd-design-spec',
        'design-spec-review',
        'feature-request-analysis',
      ],
      targetProjects: ['MaxView', 'MatterWorx'],
      skillTargets: {
        'design-spec-review': ['MaxView'],
        'prd-design-spec': ['MaxView'],
        'feature-request-analysis': ['MatterWorx'],
        // to-prd omitted → inherits both projects
      },
    });

    expect(seeded.MaxView).toEqual(
      expect.arrayContaining(['to-prd', 'prd-design-spec', 'design-spec-review']),
    );
    expect(seeded.MaxView).not.toContain('feature-request-analysis');
    expect(seeded.MatterWorx).toEqual(
      expect.arrayContaining(['to-prd', 'feature-request-analysis']),
    );
    expect(seeded.MatterWorx).not.toContain('design-spec-review');

    const resolved = resolveProjectAssignment(catalog, ['MaxView', 'MatterWorx'], seeded);
    expect(resolved.skillTargets['design-spec-review']).toEqual(['MaxView']);
    expect(resolved.skillTargets['prd-design-spec']).toEqual(['MaxView']);
    expect(resolved.skillTargets['feature-request-analysis']).toEqual(['MatterWorx']);
    expect(resolved.skillTargets['to-prd']).toBeUndefined();
  });

  it('treats empty skillTargets override as all target projects', () => {
    const seeded = seedProjectPicksFromRelease({
      selectedSkills: ['to-prd'],
      targetProjects: ['MaxView', 'MatterWorx'],
      skillTargets: { 'to-prd': [] },
    });

    expect(seeded.MaxView).toEqual(['to-prd']);
    expect(seeded.MatterWorx).toEqual(['to-prd']);
  });

  it('returns empty picks when release has no specific projects', () => {
    expect(seedProjectPicksFromRelease({
      selectedSkills: ['to-prd'],
      targetProjects: [],
      skillTargets: {},
    })).toEqual({});
  });
});
