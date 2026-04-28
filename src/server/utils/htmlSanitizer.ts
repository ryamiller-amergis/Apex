/**
 * Lightweight server-side HTML sanitizer for AI-generated mock HTML.
 *
 * Strategy:
 *   1. Strip <script> … </script> blocks (with any attributes).
 *   2. Remove all event-handler attributes (on*="…").
 *   3. Remove javascript: href/src values.
 *   4. Remove external URL references (http/https in src/href/url() pointing outside the app).
 *   5. Collapse any <link> tags (external stylesheets).
 *   6. Collapse any <meta http-equiv> tags (CSP bypass vector).
 *
 * This is intentionally NOT a full HTML parser — the mock HTML is always
 * Bedrock-generated and sandboxed in a CSP-restricted iframe, so a
 * regex pass is sufficient to block the obvious injection vectors.
 */

export function sanitizeMockHtml(raw: string): string {
  let html = raw;

  // 1. Strip <script … > … </script>
  html = html.replace(/<script[\s\S]*?<\/script\s*>/gi, '');

  // 2. Strip event-handler attributes (onclick, onmouseover, onerror, etc.)
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. Strip javascript: anywhere in attribute values
  html = html.replace(/javascript\s*:/gi, 'removed:');

  // 4. Strip external http(s) references in src / href / url()
  //    — keeps relative paths intact
  html = html.replace(/((?:src|href)\s*=\s*["'])https?:\/\/[^"']+/gi, '$1#removed');
  html = html.replace(/url\(\s*['"]?https?:\/\/[^'")]+['"]?\s*\)/gi, 'url(#removed)');

  // 5. Strip <link> tags (external stylesheets can load arbitrary CSS)
  html = html.replace(/<link\b[^>]*>/gi, '');

  // 6. Strip <meta http-equiv> (avoids CSP or refresh bypass)
  html = html.replace(/<meta\s+http-equiv\b[^>]*>/gi, '');

  // 7. Strip <base> tags
  html = html.replace(/<base\b[^>]*>/gi, '');

  return html.trim();
}
