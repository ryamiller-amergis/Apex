/**
 * FEAT-003 TBI-007 DoD-4 / PBI-011 AC-3 / VT-04 — Markdown is sanitized before storage.
 */
import { sanitizeBrainstormMarkdown } from '../../shared/utils/sanitizeBrainstormMarkdown';

describe('sanitizeBrainstormMarkdown', () => {
  it('removes script, iframe and style elements with their bodies', () => {
    const out = sanitizeBrainstormMarkdown('# Title\n\n<script>alert(1)</script>\n<iframe src="https://x"></iframe>\n<style>p{}</style>\nText');
    expect(out).not.toMatch(/script|iframe|alert|style/i);
    expect(out).toContain('# Title');
    expect(out).toContain('Text');
  });

  it('removes event-handler attributes by removing the element', () => {
    const out = sanitizeBrainstormMarkdown('Hello <img src=x onerror="alert(1)"> and <a href="#" onclick=evil()>x</a>');
    expect(out).not.toMatch(/onerror|onclick|<img|<a /i);
    expect(out).toContain('Hello');
  });

  it('removes an unclosed tag at the end of a line', () => {
    expect(sanitizeBrainstormMarkdown('a <img src=x onerror=alert(1)\nnext')).toBe('a \nnext');
  });

  it('neutralizes javascript:, vbscript: and data: link and image targets', () => {
    const out = sanitizeBrainstormMarkdown([
      '[x](javascript:alert(1))',
      '[y](  JavaScript:void(0))',
      '![i](data:image/svg+xml;base64,AAAA)',
      '[z](vbscript:msgbox)',
      '[e](java&#x73;cript:alert(1))',
      '[ref]: javascript:alert(1)',
      '[ok](https://example.com)',
    ].join('\n'));
    expect(out).not.toMatch(/javascript|vbscript|data:|&#x73;/i);
    expect(out).toContain('[x](#');
    expect(out).toContain('[ref]: #');
    expect(out).toContain('[ok](https://example.com)');
  });

  it('removes HTML comments', () => {
    expect(sanitizeBrainstormMarkdown('a<!-- hidden <script> -->b')).toBe('ab');
  });

  it('keeps fenced code, including mermaid, byte for byte', () => {
    const fence = '```mermaid\ngraph TD\n  A["<b>x</b>"] --> B\n```\n';
    const html = '~~~html\n<script>keep()</script>\n~~~\n';
    const input = `# Doc\n\n${fence}\n${html}\n<script>drop()</script>\n`;
    const out = sanitizeBrainstormMarkdown(input);
    expect(out).toContain(fence);
    expect(out).toContain(html);
    expect(out).not.toContain('drop()');
  });

  it('keeps inline code spans and safe autolinks', () => {
    const out = sanitizeBrainstormMarkdown('Use `<div onclick=x>` and see <https://apex.example/a>.');
    expect(out).toBe('Use `<div onclick=x>` and see <https://apex.example/a>.');
  });

  it('leaves plain Markdown unchanged', () => {
    const md = '# ADR\n\n## Context\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n';
    expect(sanitizeBrainstormMarkdown(md)).toBe(md);
  });
});
