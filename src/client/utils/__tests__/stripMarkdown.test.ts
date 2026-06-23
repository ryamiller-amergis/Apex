import { stripMarkdown } from '../stripMarkdown';

describe('stripMarkdown', () => {
  it('returns plain text unchanged', () => {
    expect(stripMarkdown('Hello, world!')).toBe('Hello, world!');
  });

  it('strips fenced code blocks', () => {
    expect(stripMarkdown('Before\n```js\nconst x = 1;\n```\nAfter')).toBe('Before. After');
  });

  it('strips inline code', () => {
    expect(stripMarkdown('Use `npm install` to install.')).toBe('Use npm install to install.');
  });

  it('strips images, keeping alt text', () => {
    expect(stripMarkdown('See ![diagram](https://example.com/img.png) here.')).toBe(
      'See diagram here.',
    );
  });

  it('strips links, keeping link text', () => {
    expect(stripMarkdown('Read [the docs](https://example.com) now.')).toBe('Read the docs now.');
  });

  it('strips headers', () => {
    expect(stripMarkdown('# Title\n\n## Subtitle\n\nBody text.')).toBe('Title. Subtitle. Body text.');
  });

  it('strips bold and italic markers', () => {
    expect(stripMarkdown('This is **bold** and *italic* and ***both***.')).toBe(
      'This is bold and italic and both.',
    );
    expect(stripMarkdown('Also __bold__ and _italic_.')).toBe('Also bold and italic.');
  });

  it('strips unordered list markers', () => {
    expect(stripMarkdown('- Item one\n- Item two\n* Item three')).toBe('Item one. Item two. Item three');
  });

  it('strips ordered list markers', () => {
    expect(stripMarkdown('1. First\n2. Second\n10. Tenth')).toBe('First. Second. Tenth');
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> Quoted text\n> More quote')).toBe('Quoted text. More quote');
  });

  it('strips table rows', () => {
    const md = '| Col A | Col B |\n| --- | --- |\n| val1 | val2 |\n\nAfter table.';
    expect(stripMarkdown(md)).toBe('After table.');
  });

  it('strips horizontal rules', () => {
    expect(stripMarkdown('Above\n\n---\n\nBelow')).toBe('Above. Below');
  });

  it('strips strikethrough', () => {
    expect(stripMarkdown('This is ~~deleted~~ text.')).toBe('This is deleted text.');
  });

  it('converts newlines to sentence breaks and collapses whitespace', () => {
    expect(stripMarkdown('Line one\n\nLine two\n   Line three')).toBe('Line one. Line two Line three');
  });

  it('trims leading and trailing whitespace', () => {
    expect(stripMarkdown('  \n  Hello  \n  ')).toBe('Hello');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(stripMarkdown('   \n\n  ')).toBe('');
  });
});
