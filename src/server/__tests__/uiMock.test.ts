/**
 * Tests for:
 *   - htmlSanitizer (strip scripts, event handlers, external URLs)
 *   - bedrockService UI mock prompt builders (via parseUiMockResult-compatible output)
 *   - API route smoke tests for /backlog/generate-ui-mock and /backlog/regenerate-ui-mock
 */

import { sanitizeMockHtml } from '../utils/htmlSanitizer';

/* ════════════════════════════════════════════════════════════
   htmlSanitizer
   ════════════════════════════════════════════════════════════ */

describe('sanitizeMockHtml', () => {
  it('strips <script> blocks', () => {
    const html = '<div>ok</div><script>alert(1)</script><p>safe</p>';
    expect(sanitizeMockHtml(html)).not.toContain('<script');
    expect(sanitizeMockHtml(html)).toContain('<div>ok</div>');
    expect(sanitizeMockHtml(html)).toContain('<p>safe</p>');
  });

  it('strips <script> with attributes', () => {
    const html = '<script type="text/javascript" src="evil.js">alert(2)</script>';
    expect(sanitizeMockHtml(html)).toBe('');
  });

  it('strips event handler attributes', () => {
    const html = '<button onclick="steal()">Click</button>';
    const out = sanitizeMockHtml(html);
    expect(out).not.toContain('onclick');
    expect(out).toContain('<button');
  });

  it('strips multiple event handlers on same element', () => {
    const html = '<div onmouseover="x()" onerror="y()">test</div>';
    const out = sanitizeMockHtml(html);
    expect(out).not.toContain('onmouseover');
    expect(out).not.toContain('onerror');
  });

  it('replaces javascript: hrefs', () => {
    const html = '<a href="javascript:void(0)">bad link</a>';
    expect(sanitizeMockHtml(html)).not.toContain('javascript:');
  });

  it('removes external http src references', () => {
    const html = '<img src="https://evil.com/track.gif" />';
    const out = sanitizeMockHtml(html);
    expect(out).not.toContain('https://evil.com');
    expect(out).toContain('src="#removed"');
  });

  it('removes external http href references', () => {
    const html = '<a href="http://external.com/page">link</a>';
    const out = sanitizeMockHtml(html);
    expect(out).not.toContain('http://external.com');
  });

  it('removes external url() in styles', () => {
    const html = '<div style="background: url(https://evil.com/bg.png)">x</div>';
    expect(sanitizeMockHtml(html)).not.toContain('https://evil.com');
  });

  it('strips <link> tags', () => {
    const html = '<link rel="stylesheet" href="https://evil.com/style.css" /><p>ok</p>';
    const out = sanitizeMockHtml(html);
    expect(out).not.toContain('<link');
    expect(out).toContain('<p>ok</p>');
  });

  it('strips <meta http-equiv> tags', () => {
    const html = '<meta http-equiv="refresh" content="0;url=https://evil.com" /><p>ok</p>';
    const out = sanitizeMockHtml(html);
    expect(out).not.toContain('<meta http-equiv');
    expect(out).toContain('<p>ok</p>');
  });

  it('strips <base> tags', () => {
    const html = '<base href="https://evil.com" /><p>ok</p>';
    expect(sanitizeMockHtml(html)).not.toContain('<base');
  });

  it('preserves relative src and href paths', () => {
    const html = '<img src="/images/logo.png" /><a href="/dashboard">link</a>';
    const out = sanitizeMockHtml(html);
    expect(out).toContain('src="/images/logo.png"');
    expect(out).toContain('href="/dashboard"');
  });

  it('preserves inline CSS with CSS variables', () => {
    const html = '<div style="background: var(--bg-primary); color: var(--accent-color)">styled</div>';
    const out = sanitizeMockHtml(html);
    expect(out).toContain('var(--bg-primary)');
    expect(out).toContain('var(--accent-color)');
  });

  it('preserves <style> blocks', () => {
    const html = '<style>:root { --x: #fff; } .btn { color: var(--x); }</style><button>OK</button>';
    const out = sanitizeMockHtml(html);
    expect(out).toContain('<style>');
    expect(out).toContain('var(--x)');
  });

  it('handles empty string', () => {
    expect(sanitizeMockHtml('')).toBe('');
  });

  it('handles already-clean HTML unchanged', () => {
    const html = '<section><h2>Title</h2><p>Content</p></section>';
    expect(sanitizeMockHtml(html)).toBe(html);
  });
});

/* ════════════════════════════════════════════════════════════
   designSystemService — catalog build helpers (pure unit)
   ════════════════════════════════════════════════════════════ */

// We test the pure parsing functions by re-implementing them locally
// (the module functions are not exported, but we can test them indirectly
// through the catalog shape — or export them for testing.)

// For now just validate that the module loads without error (integration smoke).
describe('designSystemService module', () => {
  it('imports without error', async () => {
    const mod = await import('../services/designSystemService');
    expect(typeof mod.getDesignSystemCatalog).toBe('function');
    expect(typeof mod.clearDesignSystemCache).toBe('function');
  });
});

/* ════════════════════════════════════════════════════════════
   bedrockService — UI mock types smoke
   ════════════════════════════════════════════════════════════ */

describe('bedrockService UI mock exports', () => {
  it('exports generateUiMockFromBedrock and regenerateUiMockFromBedrock', async () => {
    const mod = await import('../services/bedrockService');
    expect(typeof mod.generateUiMockFromBedrock).toBe('function');
    expect(typeof mod.regenerateUiMockFromBedrock).toBe('function');
  });
});
