import { markdownToAdoHtml } from '../services/playbookSteps/adoDescriptionHtml';

describe('markdownToAdoHtml', () => {
  it('turns a finding into the HTML a Bug form can show', () => {
    const html = markdownToAdoHtml([
      '**Assumptions:** Production (`mymaxview.com`).',
      '',
      '## Finding',
      'Browser **RangeError** on **Manage Timecards**.',
      '',
      '## Impact',
      '- **Environment:** Production',
      '- **Volume:** **97** exceptions',
    ].join('\n'));

    expect(html).toContain('<p><strong>Assumptions:</strong> Production (<code>mymaxview.com</code>).</p>');
    expect(html).toContain('<h2>Finding</h2>');
    expect(html).toContain('<p>Browser <strong>RangeError</strong> on <strong>Manage Timecards</strong>.</p>');
    expect(html).toContain('<ul><li><strong>Environment:</strong> Production</li><li><strong>Volume:</strong> <strong>97</strong> exceptions</li></ul>');
    expect(html).not.toContain('**');
  });

  it('escapes HTML in the report', () => {
    expect(markdownToAdoHtml('Use <script>alert(1)</script>')).toBe(
      '<p>Use &lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });
});
