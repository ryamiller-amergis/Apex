/**
 * Bounded recreation prompt builder for recreated interactive chat agents (TBI-011).
 *
 * BR-005 / BR-006: Never uses a fallback summary (`isFallback === true`) and
 * never sends a full unbounded transcript. Never logs summary or prompt text.
 */

export const DEFAULT_RECREATION_MAX_CHARS = 24_000;
export const DEFAULT_MAX_TURNS_WITHOUT_SUMMARY = 10;

export interface RecreationSummaryInput {
  summaryText: string;
  coversThroughOrdinal: number;
  isFallback?: boolean;
}

export interface RecreationMessage {
  role: 'user' | 'agent';
  text: string;
  timestamp?: string;
}

export interface BuildRecreationPromptInput {
  header?: string;
  kickoffContext?: string;
  areaKeyContext?: string | null;
  latestFullSummary: RecreationSummaryInput | null;
  messages: ReadonlyArray<RecreationMessage>;
  currentTurnBlock: string;
  maxChars?: number;
  maxTurnsWithoutSummary?: number;
}

function formatMessageEntry(
  message: RecreationMessage,
  ordinal: number,
): string {
  const timestampPart = message.timestamp
    ? ` | timestamp=${message.timestamp}`
    : '';
  return `--- message ${ordinal} | role=${message.role}${timestampPart} ---\n${message.text}`;
}

/**
 * Render an ordered slice of messages keeping the most recent messages that fit
 * within `maxChars`. If the single newest message exceeds `maxChars`, keep its
 * trailing characters so the hard character bound always holds.
 */
function renderBoundedMessages(
  messages: ReadonlyArray<RecreationMessage>,
  startOrdinal: number,
  maxChars: number,
): string {
  if (messages.length === 0 || maxChars <= 0) return '';

  const separator = '\n\n';
  const kept: string[] = [];
  let totalChars = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const formatted = formatMessageEntry(messages[i], startOrdinal + i);
    const addedLength =
      kept.length === 0 ? formatted.length : formatted.length + separator.length;

    if (totalChars + addedLength <= maxChars) {
      kept.push(formatted);
      totalChars += addedLength;
      continue;
    }

    if (kept.length === 0) {
      kept.push(formatted.slice(-maxChars));
    }
    break;
  }

  kept.reverse();
  return kept.join(separator);
}

/**
 * Build a bounded recreation prompt from optional header/kickoff/area context,
 * the latest non-fallback summary (plus only later messages) OR the bounded
 * last-N-turns recent conversation when no full summary exists, and the current
 * turn block.
 */
export function buildRecreationPrompt(
  input: BuildRecreationPromptInput,
): string {
  const maxChars =
    typeof input.maxChars === 'number' &&
    Number.isFinite(input.maxChars) &&
    input.maxChars > 0
      ? Math.floor(input.maxChars)
      : DEFAULT_RECREATION_MAX_CHARS;

  const maxTurnsWithoutSummary =
    typeof input.maxTurnsWithoutSummary === 'number' &&
    Number.isFinite(input.maxTurnsWithoutSummary) &&
    input.maxTurnsWithoutSummary >= 0
      ? Math.floor(input.maxTurnsWithoutSummary)
      : DEFAULT_MAX_TURNS_WITHOUT_SUMMARY;

  // Defensive invariant (BR-005 / BR-006): never use a fallback summary.
  const usableSummary =
    input.latestFullSummary &&
    input.latestFullSummary.isFallback !== true &&
    input.latestFullSummary.summaryText.trim().length > 0
      ? input.latestFullSummary
      : null;

  const sections: string[] = [];

  if (input.header?.trim()) {
    sections.push(input.header.trim());
  }

  if (input.kickoffContext?.trim()) {
    sections.push(input.kickoffContext.trim());
  }

  if (input.areaKeyContext?.trim()) {
    sections.push(`# Area context\n${input.areaKeyContext.trim()}`);
  }

  if (usableSummary) {
    sections.push(`# Conversation summary\n${usableSummary.summaryText.trim()}`);

    const coveredOrdinal = Math.max(
      0,
      Math.floor(usableSummary.coversThroughOrdinal),
    );
    const tailMessages = input.messages.slice(coveredOrdinal);
    const renderedTail = renderBoundedMessages(
      tailMessages,
      coveredOrdinal + 1,
      maxChars,
    );
    if (renderedTail) {
      sections.push(`# Messages after the summary\n${renderedTail}`);
    }
  } else {
    const maxMessages = maxTurnsWithoutSummary * 2;
    const recentMessages =
      maxMessages > 0 ? input.messages.slice(-maxMessages) : [];
    const startOrdinal = input.messages.length - recentMessages.length + 1;
    const renderedRecent = renderBoundedMessages(
      recentMessages,
      startOrdinal,
      maxChars,
    );
    if (renderedRecent) {
      sections.push(`# Recent conversation\n${renderedRecent}`);
    }
  }

  sections.push(`# Current turn\n${input.currentTurnBlock}`);

  return sections.join('\n\n');
}
