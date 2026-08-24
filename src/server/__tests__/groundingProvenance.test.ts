import {
  rewriteGroundingProvenanceForDisplay,
  stampGroundingProvenance,
} from '../../shared/utils/groundingProvenance';

const input = {
  groundedSha: 'A'.repeat(40),
  repository: 'AI-Pilot',
  branch: 'main',
  groundedAt: '2026-08-02T14:00:00.000Z',
};

describe('stampGroundingProvenance', () => {
  it('prefixes generated markdown with a durable SHA stamp', () => {
    const stamped = stampGroundingProvenance('# PRD\n\nHello', input);

    expect(stamped).toContain(`<!-- apex-grounded-sha:${'a'.repeat(40)} -->`);
    expect(stamped).toContain('Based on the **AI-Pilot** project, **main** branch');
    expect(stamped).toContain('# PRD');
    expect(stamped).not.toMatch(/> Grounded on /);
    expect(stamped).not.toMatch(/> Based on[^\n]*`a{40}`/);
  });

  it('replaces an existing stamp instead of stacking another copy', () => {
    const first = stampGroundingProvenance('# PRD\n\nHello', input);
    const second = stampGroundingProvenance(first, {
      ...input,
      groundedSha: 'b'.repeat(40),
    });

    expect(second.match(/apex-grounded-sha:/g)).toHaveLength(1);
    expect(second).toContain('b'.repeat(40));
    expect(second).not.toContain('a'.repeat(40));
  });

  it('leaves content unchanged when the SHA is empty', () => {
    expect(
      stampGroundingProvenance('# PRD', { ...input, groundedSha: '  ' }),
    ).toBe('# PRD');
  });
});

describe('rewriteGroundingProvenanceForDisplay', () => {
  it('hides the SHA comment and rewrites the legacy engineer quote', () => {
    const raw = [
      `<!-- apex-grounded-sha:${'a'.repeat(40)} -->`,
      '',
      `> Grounded on \`MaxView\` @ \`development\` at \`${'a'.repeat(40)}\` (Aug 19, 2026).`,
      '',
      '# PRD',
    ].join('\n');

    const displayed = rewriteGroundingProvenanceForDisplay(raw);
    expect(displayed).not.toContain('apex-grounded-sha');
    expect(displayed).not.toContain('Grounded on');
    expect(displayed).not.toContain('a'.repeat(40));
    expect(displayed).toBe(
      [
        '> Based on the **MaxView** project, **development** branch, as of Aug 19, 2026.',
        '',
        '# PRD',
      ].join('\n'),
    );
  });

  it('rewrites the no-backtick quote BAs see in the PRD preview', () => {
    const sha = '0649183681bebe4f6570ebd63ec47d75303ca447';
    const raw = [
      `<!-- apex-grounded-sha:${sha} -->`,
      `> Grounded on MaxView @ development at ${sha} (Aug 19, 2026).`,
      '',
      '# PRD',
    ].join('\n');

    const displayed = rewriteGroundingProvenanceForDisplay(raw);
    expect(displayed).not.toContain('apex-grounded-sha');
    expect(displayed).not.toContain(sha);
    expect(displayed).toBe(
      [
        '> Based on the **MaxView** project, **development** branch, as of Aug 19, 2026.',
        '',
        '# PRD',
      ].join('\n'),
    );
  });
});
