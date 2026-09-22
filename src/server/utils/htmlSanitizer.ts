/**
 * Lightweight server-side HTML sanitizer for AI-generated mock HTML.
 *
 * The iframe uses sandbox="allow-scripts" (without allow-same-origin)
 * so scripts cannot access the parent page. We allow inline <script>
 * tags and event handlers for prototype interactivity, but still strip
 * network calls, external resources, and navigation vectors.
 */

/**
 * Normalize the model's document wrapper before either transport persists it.
 *
 * Bedrock is instructed to return raw HTML but may still wrap the document in
 * one Markdown fence. Empty completions remain empty to preserve the existing
 * in-process behavior.
 */
export function normalizeGeneratedPrototypeHtml(raw: string): string {
  let html = raw.trim();
  if (html.startsWith('```')) {
    html = html
      .replace(/^```(?:html)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
  }
  return html.trim();
}

export function sanitizeMockHtml(raw: string): string {
  let html = raw;

  // 1. Strip javascript: in href/src attribute values
  html = html.replace(/javascript\s*:/gi, 'removed:');

  // 2. Strip external http(s) references in src / href / url()
  //    — keeps relative paths intact
  html = html.replace(/((?:src|href)\s*=\s*["'])https?:\/\/[^"']+/gi, '$1#removed');
  html = html.replace(/url\(\s*['"]?https?:\/\/[^'")]+['"]?\s*\)/gi, 'url(#removed)');

  // 3. Strip <link> tags (external stylesheets can load arbitrary CSS)
  html = html.replace(/<link\b[^>]*>/gi, '');

  // 4. Strip <meta http-equiv> (avoids CSP or refresh bypass)
  html = html.replace(/<meta\s+http-equiv\b[^>]*>/gi, '');

  // 5. Strip <base> tags
  html = html.replace(/<base\b[^>]*>/gi, '');

  // 6. Neutralize <a> href values to prevent navigation within the iframe.
  html = html.replace(/<a\b([^>]*?)href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '<a$1href="#"');

  // 7. Strip network APIs from inline scripts (fetch, XMLHttpRequest, etc.)
  html = html.replace(/\bfetch\s*\(/gi, '/* blocked */void(');
  html = html.replace(/new\s+XMLHttpRequest/gi, '/* blocked */void 0');
  html = html.replace(/window\s*\.\s*(?:open|location)/gi, '/* blocked */void 0');

  return html.trim();
}
