import { stripYamlFrontmatter } from '../stripYamlFrontmatter';

describe('stripYamlFrontmatter', () => {
  it('strips a well-formed frontmatter block and returns the body', () => {
    const raw = [
      '---',
      'title: Personalized User Profile and What\'s New Experience',
      'slug: personalized-user-profile-and-whats-new-experience',
      'created: 2026-07-28',
      'triage-status: needs-triage',
      'glossary-terms-used:',
      '  - PRD',
      '---',
      '',
      '# Personalized User Profile and What\'s New Experience',
      '',
      '## Problem Statement',
      '',
      'Body text.',
    ].join('\n');

    expect(stripYamlFrontmatter(raw)).toBe(
      [
        '# Personalized User Profile and What\'s New Experience',
        '',
        '## Problem Statement',
        '',
        'Body text.',
      ].join('\n')
    );
  });

  it('returns the original string when there is no frontmatter', () => {
    const raw = '# Title\n\nHello.';
    expect(stripYamlFrontmatter(raw)).toBe(raw);
  });

  it('handles CRLF line endings', () => {
    const raw = '---\r\ntitle: Foo\r\nslug: foo\r\n---\r\n\r\n# Foo\r\n';
    expect(stripYamlFrontmatter(raw)).toBe('# Foo\r\n');
  });

  it('returns empty string for empty input', () => {
    expect(stripYamlFrontmatter('')).toBe('');
  });

  it('does not strip a thematic break that is not frontmatter', () => {
    const raw = '# Title\n\n---\n\nMore text.';
    expect(stripYamlFrontmatter(raw)).toBe(raw);
  });
});
