/**
 * Strips personal data from ServiceNow incident text before it is stored, sent to the AI,
 * or posted to Teams.
 *
 * Limitation: person names in free text are not redacted. The triage prompt forbids repeating
 * them, and Teams cards carry only AI-written fields.
 */

const URL_QUERY = /(https?:\/\/[^\s?#]+)\?[^\s]*/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
const US_PHONE = /(?<![\d\w])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const PAREN_ID = /\(\s*\d{5,10}\s*\)/g;
const DIGIT_RUN_ID = /(?<![\w.])\d{6,8}(?![\w]|\.\d)/g;

export function redactIncidentText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return text
    .replace(URL_QUERY, '$1')
    .replace(BEARER_TOKEN, 'Bearer [token]')
    .replace(EMAIL, '[email]')
    .replace(SSN, '[ssn]')
    .replace(US_PHONE, '[phone]')
    .replace(PAREN_ID, '[id]')
    .replace(DIGIT_RUN_ID, '[id]');
}

/** The error name and code. A message can carry query parameters, so a log line never holds it. */
export function describeErrorForLog(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? `${error.name} (${code})` : error.name;
}

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s)\]>]*?(?=[.,;:!?]*(?:[\s)\]>]|$))/gi;
const PLACEHOLDER = /(\[(?:email|ssn|phone|id|token|link)\])/;
const MARKDOWN_SYNTAX = /[[\]()]/g;

function withoutLinks(text: string): string {
  return text.replace(MARKDOWN_LINK, (_match, label: string) => label).replace(BARE_URL, '[link]');
}

/** Escapes brackets and parentheses, except the placeholders this module writes, so no link can render. */
function escapeLinkSyntax(text: string): string {
  return text
    .split(PLACEHOLDER)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(MARKDOWN_SYNTAX, '\\$&')))
    .join('');
}

/** Text for an Adaptive Card TextBlock: redacted, with links removed, cut to `maxLen` characters before escaping. */
export function redactForTeams(text: string | null | undefined, maxLen: number): string {
  const collapsed = withoutLinks(redactIncidentText(text) ?? '').replace(/\s+/g, ' ').trim();
  const cut = collapsed.length <= maxLen
    ? collapsed
    : `${collapsed.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  return escapeLinkSyntax(cut);
}
