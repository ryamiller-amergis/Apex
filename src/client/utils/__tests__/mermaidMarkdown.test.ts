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

  it('adds mermaid language tag to bare fenced code blocks with mermaid content', () => {
    const markdown = [
      '## Diagram 1',
      '',
      '```',
      'graph TD',
      '  A["Start"] --> B["End"]',
      '```',
      '',
      'Some text.',
    ].join('\n');

    expect(normalizeMermaidBlocks(markdown)).toBe([
      '## Diagram 1',
      '',
      '```mermaid',
      'graph TD',
      '  A["Start"] --> B["End"]',
      '```',
      '',
      'Some text.',
    ].join('\n'));
  });

  it('does not add mermaid tag to non-mermaid bare fenced code blocks', () => {
    const markdown = [
      '```',
      'const x = 1;',
      '```',
    ].join('\n');

    expect(normalizeMermaidBlocks(markdown)).toBe(markdown);
  });

  it('handles tilde fences with mermaid content', () => {
    const markdown = [
      '~~~',
      'sequenceDiagram',
      '  A->>B: Hello',
      '~~~',
    ].join('\n');

    expect(normalizeMermaidBlocks(markdown)).toBe([
      '~~~mermaid',
      'sequenceDiagram',
      '  A->>B: Hello',
      '~~~',
    ].join('\n'));
  });

  it('normalizes nested stadium shape syntax that Mermaid rejects', () => {
    expect(normalizeMermaidChart('Te2e([["VT-11 to VT-15 Playwright E2E"]])')).toBe(
      'Te2e(["VT-11 to VT-15 Playwright E2E"])',
    );
  });

  it('escapes semicolons in sequence diagram message labels', () => {
    const chart = [
      'sequenceDiagram',
      '  A-->>B: status=error; local list retained',
      '  B-->>A: ok',
    ].join('\n');

    expect(normalizeMermaidChart(chart)).toBe([
      'sequenceDiagram',
      '  A-->>B: status=error#59; local list retained',
      '  B-->>A: ok',
    ].join('\n'));
  });

  it('escapes semicolons in Note lines inside sequence diagrams', () => {
    const chart = [
      'sequenceDiagram',
      '  Note over A: step 1; step 2',
    ].join('\n');

    expect(normalizeMermaidChart(chart)).toBe([
      'sequenceDiagram',
      '  Note over A: step 1#59; step 2',
    ].join('\n'));
  });

  it('does not escape semicolons in non-sequence diagrams', () => {
    const chart = 'flowchart TD\n  A["step; next"] --> B';
    expect(normalizeMermaidChart(chart)).toBe(chart);
  });
});
