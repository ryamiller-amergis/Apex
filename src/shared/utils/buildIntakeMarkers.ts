/**
 * Markers the build-intake skill writes into agent replies. The server counts
 * them; the client strips them before display.
 */

export const BUILD_INTAKE_QUESTION_MARKER = '[[build-intake:question]]';
export const BUILD_INTAKE_CONFIRM_MARKER = '[[build-intake:confirm]]';

export const SENSITIVE_CLASSES = [
  'access_token',
  'connection_string',
  'secret_key_value',
  'personal_email',
  'personal_phone',
  'personal_government_id',
  'personal_card_number',
] as const;

export type SensitiveClass = (typeof SENSITIVE_CLASSES)[number];

const SENSITIVE_CLASS_LABELS: Record<SensitiveClass, string> = {
  access_token: 'access token',
  connection_string: 'connection string',
  secret_key_value: 'secret key or password',
  personal_email: 'personal data: email address',
  personal_phone: 'personal data: phone number',
  personal_government_id: 'personal data: government ID',
  personal_card_number: 'personal data: payment card number',
};

export function sensitiveClassLabel(value: SensitiveClass): string {
  return SENSITIVE_CLASS_LABELS[value];
}

export function warningMarker(value: SensitiveClass): string {
  return `[[build-intake:warning:${value}]]`;
}

const QUESTION_RE = /\[\[build-intake:question\]\]/g;
const WARNING_RE = /\[\[build-intake:warning:([a-z_]+)\]\]/g;
const ANY_MARKER_RE = /\[\[build-intake:[a-z_:]*\]\][ \t]*/g;
const MARKER_PREFIX = 'build-intake:';

interface MarkerMessage {
  role: string;
  text: string;
  hidden?: boolean;
}

function isVisibleAgent(message: MarkerMessage): boolean {
  return message.role === 'agent' && !message.hidden;
}

/**
 * Question markers in visible agent messages. With `sinceLastConfirm`, only
 * messages after the latest confirm message count (a revision round).
 */
export function countQuestionMarkers(
  messages: ReadonlyArray<MarkerMessage>,
  options?: { sinceLastConfirm?: boolean },
): number {
  const agentTexts = messages.filter(isVisibleAgent).map((message) => message.text);
  let start = 0;
  if (options?.sinceLastConfirm) {
    for (let index = agentTexts.length - 1; index >= 0; index -= 1) {
      if (hasConfirmMarker(agentTexts[index])) {
        start = index + 1;
        break;
      }
    }
  }
  return agentTexts
    .slice(start)
    .reduce((total, text) => total + (text.match(QUESTION_RE)?.length ?? 0), 0);
}

export function hasConfirmMarker(text: string): boolean {
  return text.includes(BUILD_INTAKE_CONFIRM_MARKER);
}

export function warningClasses(text: string): SensitiveClass[] {
  const found = new Set<SensitiveClass>();
  for (const match of text.matchAll(WARNING_RE)) {
    const value = match[1] as SensitiveClass;
    if ((SENSITIVE_CLASSES as readonly string[]).includes(value)) found.add(value);
  }
  return [...found];
}

/** A marker still being streamed: `[[`, `[[build-in`, `[[build-intake:warn`, … */
function stripTrailingPartialMarker(text: string): string {
  const start = text.lastIndexOf('[[');
  if (start < 0) return text;
  const tail = text.slice(start + 2);
  if (tail.includes(']]')) return text;
  const body = tail.endsWith(']') ? tail.slice(0, -1) : tail;
  const isMarkerPrefix = MARKER_PREFIX.startsWith(body)
    || (body.startsWith(MARKER_PREFIX) && /^[a-z_:]*$/.test(body.slice(MARKER_PREFIX.length)));
  return isMarkerPrefix ? text.slice(0, start) : text;
}

export function stripBuildIntakeMarkers(text: string): string {
  if (!text.includes('[[')) return text;
  return stripTrailingPartialMarker(text.replace(ANY_MARKER_RE, ''));
}
