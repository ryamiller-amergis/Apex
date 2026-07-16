/**
 * Tests for adoRichText utilities.
 */

import { markdownToAdoHtml, normalizeAdoHtml } from '../utils/adoRichText';

describe('markdownToAdoHtml', () => {
  it('returns empty string for empty input', () => {
    expect(markdownToAdoHtml('')).toBe('');
    expect(markdownToAdoHtml('   ')).toBe('');
  });

  it('wraps plain text in a paragraph', () => {
    const html = markdownToAdoHtml('Hello world');
    expect(html).toBe('<p>Hello world</p>');
  });

  it('produces a <ul> for unordered list items', () => {
    const html = markdownToAdoHtml('- First\n- Second');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<li>Second</li>');
  });

  it('converts **bold** to <strong>', () => {
    const html = markdownToAdoHtml('This is **important**');
    expect(html).toContain('<strong>important</strong>');
  });

  it('converts inline `code` to <code>', () => {
    const html = markdownToAdoHtml('Use `myFunction()`');
    expect(html).toContain('<code>myFunction()</code>');
  });

  it('converts safe https links to <a>', () => {
    const html = markdownToAdoHtml('[Click here](https://example.com)');
    expect(html).toContain('<a href="https://example.com">Click here</a>');
  });

  it('does not allow javascript: links', () => {
    const html = markdownToAdoHtml('[bad](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<a ');
  });

  it('escapes HTML special characters in text', () => {
    const html = markdownToAdoHtml('Use <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes & in text', () => {
    const html = markdownToAdoHtml('Me & you');
    expect(html).toContain('&amp;');
  });

  it('bolds Given/When/Then in acceptance criteria text', () => {
    const html = markdownToAdoHtml('Given a user When they click Then it works');
    expect(html).toContain('<strong>Given</strong>');
    expect(html).toContain('<strong>When</strong>');
    expect(html).toContain('<strong>Then</strong>');
  });

  it('handles multiple paragraphs separated by blank lines', () => {
    const html = markdownToAdoHtml('First paragraph\n\nSecond paragraph');
    expect(html).toContain('<p>First paragraph</p>');
    expect(html).toContain('<p>Second paragraph</p>');
  });

  it('mixes paragraphs and lists correctly', () => {
    const html = markdownToAdoHtml('Intro text\n\n- item one\n- item two\n\nConclusion');
    expect(html).toContain('<p>Intro text</p>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<p>Conclusion</p>');
  });
});

describe('normalizeAdoHtml', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeAdoHtml('')).toBe('');
    expect(normalizeAdoHtml('   ')).toBe('');
  });

  it('strips all HTML tags', () => {
    const text = normalizeAdoHtml('<p>Hello <strong>world</strong></p>');
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
  });

  it('decodes HTML entities', () => {
    const text = normalizeAdoHtml('<p>Me &amp; you &lt;3</p>');
    expect(text).toContain('Me & you <3');
  });

  it('converts </p> to line breaks', () => {
    const text = normalizeAdoHtml('<p>First</p><p>Second</p>');
    expect(text).toContain('First');
    expect(text).toContain('Second');
    // Both paragraphs should be on separate lines
    const lines = text.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('converts <li> to bullet format', () => {
    const text = normalizeAdoHtml('<ul><li>Item one</li><li>Item two</li></ul>');
    expect(text).toContain('• Item one');
    expect(text).toContain('• Item two');
  });

  it('converts <br/> to newlines', () => {
    const text = normalizeAdoHtml('Line one<br/>Line two');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Line one');
    expect(lines[1]).toBe('Line two');
  });

  it('collapses whitespace-only lines', () => {
    const text = normalizeAdoHtml('<p>  </p><p>Content</p>');
    expect(text).not.toContain('\n\n\n');
    expect(text).toContain('Content');
  });
});
