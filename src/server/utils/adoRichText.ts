/**
 * ADO-safe rich-text utilities.
 *
 * - markdownToAdoHtml: converts constrained agent Markdown to ADO-acceptable
 *   HTML. All raw HTML from the model is escaped; only allow-listed inline
 *   formatting is emitted.
 * - normalizeAdoHtml: strips ADO HTML tags to produce a plain-text string
 *   suitable for diff display and "before" snapshot comparison.
 * - MAX_FIELD_BYTES: exported constant for content-size checks.
 */

/** Allowed HTTP/HTTPS URL pattern for link safety. */
const SAFE_URL_RE = /^https?:\/\//i;

/** Escape HTML special characters in user/model-supplied text. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert constrained Markdown (produced by the calendar assistant agent) to
 * ADO-safe HTML.
 *
 * Supported constructs:
 *   - Blank-line-separated paragraphs
 *   - Unordered list items starting with `- `
 *   - Bold via `**text**`
 *   - Inline code via `` `text` ``
 *   - Markdown links `[label](url)` — only `http/https` URLs pass through;
 *     all others are rendered as escaped plain text
 *   - Given/When/Then keywords bolded automatically (ADO AC convention)
 *
 * Everything else (raw HTML tags, images, scripts, headings, tables) is HTML-
 * escaped so it appears as literal text in ADO.
 */
export function markdownToAdoHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return '';

  const blocks = markdown.split(/\n{2,}/);
  let html = '';

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const listLines = lines.filter(l => l.startsWith('- '));
    const textLines = lines.filter(l => !l.startsWith('- '));

    if (textLines.length > 0) {
      const rendered = textLines.map(l => renderInline(l)).join('<br/>');
      html += `<p>${rendered}</p>`;
    }
    if (listLines.length > 0) {
      const items = listLines.map(l => `<li>${renderInline(l.slice(2))}</li>`).join('');
      html += `<ul>${items}</ul>`;
    }
  }

  return html;
}

/** Render inline Markdown constructs in a single line. */
function renderInline(raw: string): string {
  let text = raw;

  // Escape HTML first so subsequent replacements work on safe text
  text = esc(text);

  // Bold: **text** — already escaped, so look for **...**
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Inline code: `text`
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links: [label](url) — only safe URLs pass through; escaped label/url already safe
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label, url) => {
      const decodedUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      if (SAFE_URL_RE.test(decodedUrl)) {
        return `<a href="${esc(decodedUrl)}">${label}</a>`;
      }
      return `${label} (${url})`;
    },
  );

  // Given / When / Then bolding (ADO AC convention)
  text = text
    .replace(/\bGiven\b/g, '<strong>Given</strong>')
    .replace(/\bWhen\b/g, '<strong>When</strong>')
    .replace(/\bThen\b/g, '<strong>Then</strong>')
    .replace(/\bAnd\b(?=\s)/g, '<strong>And</strong>');

  return text;
}

/**
 * Normalise ADO HTML to plain text for diff display and snapshot comparison.
 *
 * - Strips all HTML tags
 * - Converts `<br>`, `<br/>`, `</p>`, `</li>` to newlines
 * - Decodes common HTML entities
 * - Collapses runs of whitespace
 */
export function normalizeAdoHtml(html: string): string {
  if (!html || !html.trim()) return '';

  let text = html;

  // Block-level line breaks
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/ul>/gi, '\n');
  text = text.replace(/<\/ol>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '• ');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Normalise whitespace
  text = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');

  return text.trim();
}
