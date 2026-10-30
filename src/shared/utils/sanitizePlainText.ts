/**
 * Plain-text sanitizer for citation claims. Strips tags, event-handler
 * fragments, and javascript: URLs, then collapses whitespace.
 * FEAT-003's Markdown sanitizer can call this for the text it extracts.
 */
const TAG_OR_HANDLER = /<\/?[^>]*>|on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JAVASCRIPT_URL = /javascript\s*:/gi;
// eslint-disable-next-line no-control-regex -- intentionally strips ASCII control characters from plain text
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const CITATION_CLAIM_MAX_LENGTH = 500;

export function sanitizePlainText(value: string, maxLength = CITATION_CLAIM_MAX_LENGTH): string {
  const stripped = value
    .replace(TAG_OR_HANDLER, ' ')
    .replace(JAVASCRIPT_URL, '')
    .replace(CONTROL, '');
  return stripped.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
