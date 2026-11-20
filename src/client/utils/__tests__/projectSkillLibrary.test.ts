import {
  buildProjectSkillMarkdown,
  decodeSkillFileText,
  filterProjectSkills,
  skillFileName,
  skillInstructions,
  skillNameFromTitle,
  type ProjectSkillLibraryItem,
} from '../projectSkillLibrary';

function skill(name: string): ProjectSkillLibraryItem {
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
        outputKind: null,
        content: '---\nname: x\n---\nBody',
        createdBy: 'author',
        createdAt: '2026-11-18T00:00:00.000Z',
        files: [],
      },
    ],
  };
}

describe('project skill library helpers', () => {
  it('turns a title into a skill name and markdown with no output kind', () => {
    expect(skillNameFromTitle(' Incident Notes! ')).toBe('incident-notes');
    const built = buildProjectSkillMarkdown({
      title: 'Incident Notes',
      description: 'Look up an outage',
      skillType: 'autonomous',
      body: 'Read the catalog.',
    });
    expect(built.name).toBe('incident-notes');
    expect(built.content).toContain('name: incident-notes');
    expect(built.content).toContain('skill-type: autonomous');
    expect(built.content).not.toContain('output-kind');
    expect(built.content).toContain('Read the catalog.');
    expect(skillInstructions(built.content)).toBe('Read the catalog.');
  });

  it('keeps the extension of a picked file and cleans the rest of the name', () => {
    expect(skillFileName('notes.md')).toBe('notes.md');
    expect(skillFileName('Run book (v2).txt')).toBe('Run-book-v2-.txt');
    expect(skillFileName('C:\\docs\\catalog.json')).toBe('catalog.json');
    expect(skillFileName('.env')).toBeNull();
    expect(skillFileName('README')).toBeNull();
    expect(skillFileName('skill.md')).toBeNull();
  });

  it('decodes UTF-8 text and refuses binary bytes', () => {
    expect(decodeSkillFileText(new TextEncoder().encode('\uFEFFhello').buffer)).toBe('hello');
    expect(decodeSkillFileText(new Uint8Array([0x25, 0x50, 0x00, 0x01]).buffer)).toBeNull();
    expect(decodeSkillFileText(new Uint8Array([0xff, 0xfe, 0xfd]).buffer)).toBeNull();
  });

  it('filters by search', () => {
    const skills = [skill('alpha'), skill('beta')];
    expect(filterProjectSkills(skills, 'alp').map((item) => item.name)).toEqual(['alpha']);
    expect(filterProjectSkills(skills, 'nope')).toEqual([]);
    expect(filterProjectSkills(skills, '').map((item) => item.name)).toEqual(['alpha', 'beta']);
  });
});
