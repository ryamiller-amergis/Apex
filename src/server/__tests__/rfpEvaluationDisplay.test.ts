import { formatRationaleMarkdown, formatRfpStatusSubtitle } from '../../shared/utils/rfpEvaluationDisplay';

describe('formatRationaleMarkdown', () => {
  it('keeps markdown with headings', () => {
    const input = '## Call\nBuild it.\n\n## Caveat\nOwner is unassigned.';
    expect(formatRationaleMarkdown(input)).toBe(input);
  });

  it('labels AI and reviewer verdicts in the subtitle', () => {
    expect(formatRfpStatusSubtitle('evaluated', 'buy', 'build')).toBe(
      'Evaluated · AI: Buy · Reviewer: Build',
    );
  });

  it('splits semicolon-packed legacy rationale into paragraphs', () => {
    const formatted = formatRationaleMarkdown(
      'Buy Cornerstone; Axis A is moderate; Host on vendor SaaS',
    );
    expect(formatted).toContain('\n\n');
    expect(formatted).toMatch(/Buy Cornerstone\./);
  });

  it('chunks a long single paragraph into two-sentence blocks', () => {
    const formatted = formatRationaleMarkdown(
      'First sentence. Second sentence. Third sentence. Fourth sentence.',
    );
    expect(formatted.split('\n\n')).toHaveLength(2);
  });
});
