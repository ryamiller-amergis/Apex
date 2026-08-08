import {
  collectFoundationSkillValidationIssues,
  resolveFoundationSkillSelection,
} from '../../shared/foundationSkillDependencies';
import type { FoundationSkillCatalogEntry } from '../../shared/types/foundationSkills';

const catalog: FoundationSkillCatalogEntry[] = [
  { name: 'prd-spec-review', summary: 'Review PRDs.', tier: 'shippable', dependsOn: ['to-prd'] },
  { name: 'design-spec-review', summary: 'Review design specs.', tier: 'shippable', dependsOn: ['prd-design-spec', 'to-prd'] },
  { name: 'to-prd', summary: 'Generate PRDs.', tier: 'shippable', dependsOn: [] },
  { name: 'prd-design-spec', summary: 'Generate design specs.', tier: 'shippable', dependsOn: ['to-prd'] },
];

describe('resolveFoundationSkillSelection', () => {
  it('derives transitive closure and dependency order deterministically', () => {
    const result = resolveFoundationSkillSelection(catalog, ['design-spec-review']);

    expect(result.explicitSelectedSkills).toEqual(['design-spec-review']);
    expect(result.effectiveSelectedSkills).toEqual([
      'design-spec-review',
      'to-prd',
      'prd-design-spec',
    ]);
    expect(result.dependencyOrder).toEqual([
      'to-prd',
      'prd-design-spec',
      'design-spec-review',
    ]);
    expect(result.requiredBy['to-prd']).toEqual(['design-spec-review', 'prd-design-spec']);
    expect(result.requiredBy['prd-design-spec']).toEqual(['design-spec-review']);
  });

  it('keeps shared dependencies until the final dependent is removed', () => {
    const bothSelected = resolveFoundationSkillSelection(catalog, [
      'prd-spec-review',
      'design-spec-review',
    ]);
    expect(bothSelected.effectiveSelectedSkills).toEqual([
      'prd-spec-review',
      'design-spec-review',
      'to-prd',
      'prd-design-spec',
    ]);

    const remainingDependent = resolveFoundationSkillSelection(catalog, ['design-spec-review']);
    expect(remainingDependent.effectiveSelectedSkills).toEqual([
      'design-spec-review',
      'to-prd',
      'prd-design-spec',
    ]);

    const noneSelected = resolveFoundationSkillSelection(catalog, []);
    expect(noneSelected.effectiveSelectedSkills).toEqual([]);
  });

  it('records unknown dependencies and cycles without looping forever', () => {
    const result = resolveFoundationSkillSelection(
      [
        { name: 'cycle-a', summary: 'A', tier: 'shippable', dependsOn: ['cycle-b'] },
        { name: 'cycle-b', summary: 'B', tier: 'shippable', dependsOn: ['cycle-a'] },
        { name: 'unknown-parent', summary: 'C', tier: 'shippable', dependsOn: ['missing-skill'] },
      ],
      ['cycle-a', 'unknown-parent'],
    );

    expect(result.effectiveSelectedSkills).toEqual(['cycle-a', 'cycle-b', 'unknown-parent']);
    expect(result.cycles).toEqual([['cycle-a', 'cycle-b', 'cycle-a']]);
    expect(result.unknownDependencies).toEqual([
      { skill: 'unknown-parent', dependency: 'missing-skill' },
    ]);
  });
});

describe('collectFoundationSkillValidationIssues', () => {
  it('aggregates every missing dependency for the selected set', () => {
    const issues = collectFoundationSkillValidationIssues({
      skills: catalog,
      selectedSkills: ['design-spec-review'],
      targetProjects: [],
      skillTargets: {},
    });

    expect(issues).toEqual([
      expect.objectContaining({
        type: 'missing_dependency',
        dependentSkill: 'design-spec-review',
        dependency: 'prd-design-spec',
      }),
      expect.objectContaining({
        type: 'missing_dependency',
        dependentSkill: 'design-spec-review',
        dependency: 'to-prd',
      }),
    ]);
  });

  it('aggregates every dependency audience gap with project-specific remediation', () => {
    const issues = collectFoundationSkillValidationIssues({
      skills: catalog,
      selectedSkills: ['prd-spec-review', 'design-spec-review', 'to-prd', 'prd-design-spec'],
      targetProjects: [],
      skillTargets: {
        'prd-spec-review': ['Apex'],
        'design-spec-review': ['MaxView'],
        'to-prd': ['Apex'],
        'prd-design-spec': ['MatterWorx'],
      },
    });

    expect(issues).toHaveLength(3);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'audience_gap',
          dependentSkill: 'design-spec-review',
          dependency: 'to-prd',
          dependentProjects: ['MaxView'],
          dependencyProjects: ['Apex'],
        }),
        expect.objectContaining({
          type: 'audience_gap',
          dependentSkill: 'design-spec-review',
          dependency: 'prd-design-spec',
          dependentProjects: ['MaxView'],
          dependencyProjects: ['MatterWorx'],
        }),
        expect.objectContaining({
          type: 'audience_gap',
          dependentSkill: 'prd-design-spec',
          dependency: 'to-prd',
          dependentProjects: ['MatterWorx'],
          dependencyProjects: ['Apex'],
        }),
      ]),
    );
    for (const issue of issues) {
      expect(issue.remediation).toMatch(/expand|narrow/i);
    }
  });
});
