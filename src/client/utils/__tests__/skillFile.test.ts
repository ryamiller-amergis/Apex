import { blankSkillFile, readSkillFile, splitSkillFile, updateSkillFile } from '../skillFile';

const FILE = [
  '---',
  'name: incident-notes',
  'description: "Look up an outage"',
  'playbook-capabilities: [azure-cli]',
  'metadata:',
  '  apex:',
  '    skill-type: interactive',
  '    owner: platform',
  '---',
  '',
  'Read the catalog.',
  '',
].join('\n');

describe('skill file helpers', () => {
  it('splits the frontmatter from the instructions', () => {
    const { frontmatter, body } = splitSkillFile(FILE);
    expect(frontmatter).toContain('name: incident-notes');
    expect(body.trim()).toBe('Read the catalog.');
    expect(splitSkillFile('No fence').frontmatter).toBeNull();
  });

  it('reads the fields the editor shows', () => {
    expect(readSkillFile(FILE)).toEqual({
      name: 'incident-notes',
      description: 'Look up an outage',
      skillType: 'interactive',
      tools: ['azure-cli'],
      body: 'Read the catalog.',
    });
  });

  it('reads folded and literal descriptions, single quotes, and a block tool list', () => {
    const folded = '---\nname: a\ndescription: >\n  First line\n  second line\nplaybook-capabilities:\n- azure-cli\n- aws-cli\n---\nBody';
    expect(readSkillFile(folded)).toMatchObject({
      description: 'First line second line',
      tools: ['azure-cli', 'aws-cli'],
    });
    expect(readSkillFile("---\nname: a\ndescription: 'It''s here'\n---\nBody").description).toBe("It's here");
    expect(readSkillFile('---\nname: a\ndescription: |\n  one\n  two\n---\nBody').description).toBe('one\ntwo');
  });

  it('reports a file with no frontmatter as empty fields and the whole text as the body', () => {
    expect(readSkillFile('Just text')).toEqual({
      name: '',
      description: '',
      skillType: null,
      tools: [],
      body: 'Just text',
    });
  });

  it('edits one field and leaves other lines, including unknown ones, as written', () => {
    const next = updateSkillFile(FILE, { description: 'Check "prod" first' });
    expect(next).toContain('description: "Check \\"prod\\" first"');
    expect(next).toContain('    owner: platform');
    expect(next).toContain('playbook-capabilities: [azure-cli]');
    expect(readSkillFile(next).description).toBe('Check "prod" first');
  });

  it('keeps a trailing space typed into the description', () => {
    expect(readSkillFile(updateSkillFile(FILE, { description: 'two words ' })).description).toBe('two words ');
  });

  it('replaces a folded description as a whole entry', () => {
    const folded = '---\nname: a\ndescription: >\n  First\n  second\nmetadata:\n  apex:\n    skill-type: autonomous\n---\nBody';
    const next = updateSkillFile(folded, { description: 'Short' });
    expect(next).toBe('---\nname: a\ndescription: "Short"\nmetadata:\n  apex:\n    skill-type: autonomous\n---\nBody');
  });

  it('changes the skill type in place and adds the metadata block when it is missing', () => {
    expect(readSkillFile(updateSkillFile(FILE, { skillType: 'autonomous' })).skillType).toBe('autonomous');
    const added = updateSkillFile('---\nname: a\ndescription: "d"\n---\nBody', { skillType: 'interactive' });
    expect(readSkillFile(added).skillType).toBe('interactive');
    const underMetadata = updateSkillFile('---\nname: a\nmetadata:\n  other: 1\n---\nBody', { skillType: 'autonomous' });
    expect(underMetadata).toContain('metadata:\n  apex:\n    skill-type: autonomous\n  other: 1');
  });

  it('writes the tools line, and removes it when no tool is left', () => {
    const withTwo = updateSkillFile(FILE, { tools: ['azure-cli', 'aws-cli', 'aws-cli'] });
    expect(withTwo).toContain('playbook-capabilities: [azure-cli, aws-cli]');
    expect(readSkillFile(withTwo).tools).toEqual(['azure-cli', 'aws-cli']);
    const none = updateSkillFile(FILE, { tools: [] });
    expect(none).not.toContain('playbook-capabilities');
    const added = updateSkillFile('---\nname: a\n---\nBody', { tools: ['azure-cli'] });
    expect(added).toBe('---\nname: a\nplaybook-capabilities: [azure-cli]\n---\nBody');
  });

  it('replaces the instructions and quotes a name that YAML would read as a number', () => {
    const next = updateSkillFile(FILE, { body: '  New steps.  ', name: '123' });
    expect(readSkillFile(next).body).toBe('New steps.');
    expect(next).toContain('name: "123"');
  });

  it('keeps Windows line endings', () => {
    const next = updateSkillFile(FILE.replace(/\n/g, '\r\n'), { description: 'x' });
    expect(next).not.toMatch(/[^\r]\n/);
    expect(readSkillFile(next).description).toBe('x');
  });

  it('builds a blank file the fields can fill in', () => {
    const blank = blankSkillFile();
    expect(readSkillFile(blank)).toEqual({ name: '', description: '', skillType: 'autonomous', tools: [], body: '' });
    const filled = updateSkillFile(blank, { name: 'new-skill', description: 'Does a thing', body: 'Do it.' });
    expect(readSkillFile(filled)).toMatchObject({ name: 'new-skill', description: 'Does a thing', body: 'Do it.' });
  });
});
