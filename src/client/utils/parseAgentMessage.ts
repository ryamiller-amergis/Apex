export interface ChoiceOption {
  letter: string;
  text: string;
}

export interface ChoiceBlock {
  type: 'choices';
  id: string;
  question: string;
  options: ChoiceOption[];
}

export interface MarkdownBlock {
  type: 'markdown';
  id: string;
  content: string;
}

export type MessagePart = MarkdownBlock | ChoiceBlock;

// Single-line option: "a. text", "b) text", "A. text", "A **bold**"
// Letters a–e so agent "e. Other — describe" can be matched then stripped.
const OPTION_RE = /^[\s\-*]*([a-eA-E])(?:[.)]\s+|\s+(?=\*\*))(.+)$/;

// Standalone letter on its own line: "A", "  B", "- C"
const SOLO_LETTER_RE = /^[\s\-*]*([a-eA-E])\s*$/;

/** Agent "Other — describe" lines; UI already provides Other / free-form. */
const OTHER_OPTION_RE = /^other\b/i;

/**
 * Strip common inline markdown so "Other" detection works when the agent
 * wraps the label (e.g. `E. **Other — describe** (…)`).
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** True for agent "Other / describe" choice text (plain or markdown-wrapped). */
export function isAgentOtherOptionText(text: string): boolean {
  return OTHER_OPTION_RE.test(stripInlineMarkdown(text));
}

function isOrphanOtherLine(line: string): boolean {
  const match = line.match(/^[\s\-*]*[a-eA-E](?:[.)]\s+|\s+)(.+)$/);
  return match ? isAgentOtherOptionText(match[1]) : false;
}

/**
 * Try to match an option starting at line index `i`.
 * Handles both single-line ("A. text") and multi-line ("A\n**text**") formats.
 * Returns [letter, text, linesConsumed] or null.
 */
function tryMatchOption(lines: string[], i: number): [string, string, number] | null {
  const singleMatch = lines[i].match(OPTION_RE);
  if (singleMatch) {
    return [singleMatch[1].toLowerCase(), singleMatch[2].trim(), 1];
  }

  const soloMatch = lines[i].match(SOLO_LETTER_RE);
  if (soloMatch && i + 1 < lines.length) {
    const nextLine = lines[i + 1].trim();
    if (nextLine.length > 0) {
      return [soloMatch[1].toLowerCase(), nextLine, 2];
    }
  }

  return null;
}

export function parseAgentMessage(text: string): MessagePart[] {
  const lines = text.split('\n');
  const parts: MessagePart[] = [];
  let pendingLines: string[] = [];
  let partIdx = 0;

  const flushPending = () => {
    const content = pendingLines.join('\n').trim();
    if (content) {
      parts.push({ type: 'markdown', id: `md-${partIdx++}`, content });
    }
    pendingLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    // Swallow orphan "e. Other — describe" lines that are not part of a choice block.
    if (isOrphanOtherLine(lines[i])) {
      i++;
      continue;
    }

    const optMatch = tryMatchOption(lines, i);
    if (optMatch) {
      const options: ChoiceOption[] = [];
      while (i < lines.length) {
        const m = tryMatchOption(lines, i);
        if (m) {
          if (!isAgentOtherOptionText(m[1])) {
            options.push({ letter: m[0], text: m[1] });
          }
          i += m[2];
        } else if (lines[i].trim() === '' && i + 1 < lines.length && tryMatchOption(lines, i + 1)) {
          i++;
        } else if (isOrphanOtherLine(lines[i])) {
          i++;
        } else {
          break;
        }
      }

      if (options.length >= 2) {
        const fullPending = pendingLines.join('\n').trimEnd();
        const lastBlankIdx = fullPending.lastIndexOf('\n\n');
        let questionText = '';

        if (lastBlankIdx >= 0) {
          const before = fullPending.slice(0, lastBlankIdx).trim();
          questionText = fullPending.slice(lastBlankIdx + 2).trim();
          pendingLines = before ? [before] : [];
          flushPending();
        } else {
          questionText = fullPending;
          pendingLines = [];
        }

        parts.push({
          type: 'choices',
          id: `choices-${partIdx++}`,
          question: questionText,
          options,
        });
      } else {
        for (const o of options) {
          pendingLines.push(`${o.letter}. ${o.text}`);
        }
      }
    } else {
      pendingLines.push(lines[i]);
      i++;
    }
  }

  flushPending();
  return parts;
}
