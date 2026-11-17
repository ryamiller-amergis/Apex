import {
  brainstormInterviewOpeningPrompt,
  brainstormInterviewSkillName,
  brainstormInterviewTitle,
} from '../brainstormInterviewPrefill';

describe('brainstormInterviewTitle', () => {
  it('uses the first H1 of the artifact', () => {
    expect(brainstormInterviewTitle('Intro line\n\n# Queue design\n\n## Goals', 'chat title')).toBe('Queue design');
  });

  it('ignores headings inside frontmatter and code fences', () => {
    const markdown = '---\ntitle: x\n---\n```md\n# Not this\n```\n# Real title #\n';
    expect(brainstormInterviewTitle(markdown, null)).toBe('Real title');
  });

  it('falls back to the session title, then to a generic label', () => {
    expect(brainstormInterviewTitle('No heading here', '  Queue chat ')).toBe('Queue chat');
    expect(brainstormInterviewTitle('', null)).toBe('Untitled brainstorm');
  });

  it('caps the title at 200 characters', () => {
    expect(brainstormInterviewTitle(`# ${'a'.repeat(300)}`, null)).toHaveLength(200);
  });
});

describe('brainstormInterviewSkillName', () => {
  it('maps a technical design to grill-design', () => {
    expect(brainstormInterviewSkillName('technical_design')).toBe('grill-design');
  });

  it('leaves the project default for a discovery brief', () => {
    expect(brainstormInterviewSkillName('discovery_brief')).toBeNull();
    expect(brainstormInterviewSkillName(null)).toBeNull();
  });
});

describe('brainstormInterviewOpeningPrompt', () => {
  it('names the linked brainstorm in one short paragraph', () => {
    const prompt = brainstormInterviewOpeningPrompt('Queue design');
    expect(prompt).toContain('"Queue design"');
    expect(prompt).toMatch(/linked brainstorm/i);
    expect(prompt.length).toBeLessThan(300);
    expect(prompt).not.toContain('\n');
  });
});
