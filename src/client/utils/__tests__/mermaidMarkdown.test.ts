import { normalizeMermaidBlocks, normalizeMermaidChart } from '../mermaidMarkdown';

describe('mermaidMarkdown', () => {
  it('wraps bare Mermaid blocks in a mermaid code fence', () => {
    const markdown = [
      '## Architecture',
      '',
      'flowchart TD',
      '  A["Start"] --> B["Done"]',
      '',
      '## Next Section',
      'Regular text.',
    ].join('\n');

    expect(normalizeMermaidBlocks(markdown)).toBe([
      '## Architecture',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["Start"] --> B["Done"]',
      '',
      '```',
      '## Next Section',
      'Regular text.',
    ].join('\n'));
  });

  it('does not re-wrap already fenced Mermaid blocks', () => {
    const markdown = [
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
    ].join('\n');

    expect(normalizeMermaidBlocks(markdown)).toBe(markdown);
  });

  it('normalizes nested stadium shape syntax that Mermaid rejects', () => {
    expect(normalizeMermaidChart('Te2e([["VT-11 to VT-15 Playwright E2E"]])')).toBe(
      'Te2e(["VT-11 to VT-15 Playwright E2E"])',
    );
  });
});
