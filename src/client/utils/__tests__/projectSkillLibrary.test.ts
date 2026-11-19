import {
  buildProjectSkillMarkdown,
  companionFileName,
  filterProjectSkills,
  skillNameFromTitle,
  type ProjectSkillLibraryItem,
} from '../projectSkillLibrary';

function skill(name: string, pending: boolean): ProjectSkillLibraryItem {
  return {
    id: name,
    name,
    description: `${name} description`,
    versions: [
      {
        id: `${name}-v1`,
        versionNumber: 1,
        status: 'published',
        skillType: 'autonomous',
        outputKind: 'document@1',
        createdBy: 'author',
        createdAt: '2026-11-18T00:00:00.000Z',
        files: pending
          ? [{
              id: `${name}-file`,
              fileName: 'NOTES.md',
              classification: 'reference',
              approvalStatus: 'pending',
            }]
          : [],
      },
    ],
  };
}

describe('project skill library helpers', () => {
  it('turns a title into a skill name and markdown', () => {
    expect(skillNameFromTitle(' Incident Notes! ')).toBe('incident-notes');
    const built = buildProjectSkillMarkdown({
      title: 'Incident Notes',
      description: 'Look up an outage',
      skillType: 'autonomous',
      outputKind: 'report@1',
      body: 'Read the catalog.',
    });
    expect(built.name).toBe('incident-notes');
    expect(built.content).toContain('name: incident-notes');
    expect(built.content).toContain('skill-type: autonomous');
    expect(built.content).toContain('output-kind: report@1');
    expect(built.content).toContain('Read the catalog.');
  });

  it('accepts a companion markdown name and refuses SKILL.md', () => {
    expect(companionFileName('notes')).toBe('notes.md');
    expect(companionFileName('SKILL.md')).toBeNull();
    expect(companionFileName('../secret.md')).toBeNull();
  });

  it('filters by search and pending reference files', () => {
    const skills = [skill('alpha', false), skill('beta', true)];
    expect(filterProjectSkills(skills, 'all', 'alp').map((item) => item.name)).toEqual(['alpha']);
    expect(filterProjectSkills(skills, 'pending-reference', '').map((item) => item.name)).toEqual(['beta']);
    expect(filterProjectSkills(skills, 'pending-reference', 'nope')).toEqual([]);
  });
});
