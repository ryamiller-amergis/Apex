import React from 'react';

const STORY_PART =
  /^(As a|As an|I want|I need|so that)\b\s*:?\s*(.*)$/i;

/**
 * Renders Mike Cohn user-story text with As a / I want / so that keywords in bold.
 * Works for single-line or multi-line stories; normalizes keywords with a trailing colon.
 */
export function formatUserStoryText(text: string, keywordClassName?: string): React.ReactNode {
  const trimmed = text.trim();
  if (!trimmed) return text;

  // Prefer line-based formatting when the story is already broken into lines
  const lines = text.split('\n');
  const lineBased = lines.some((l) => STORY_PART.test(l.trim()));
  if (lineBased) {
    return lines.map((line, i) => {
      const match = STORY_PART.exec(line.trim());
      const prefix = i > 0 ? '\n' : '';
      if (!match) {
        return (
          <React.Fragment key={i}>
            {prefix}
            {line}
          </React.Fragment>
        );
      }
      const label = normalizeKeyword(match[1]);
      const rest = match[2];
      return (
        <React.Fragment key={i}>
          {prefix}
          <strong className={keywordClassName}>{label}</strong>
          {rest ? ` ${rest}` : ''}
        </React.Fragment>
      );
    });
  }

  // Single-line: "As a X, I want Y, so that Z"
  const parts = trimmed.split(/,\s*(?=(?:I want|I need|so that)\b)/i);
  if (parts.length >= 2) {
    return parts.map((part, i) => {
      const match = STORY_PART.exec(part.trim());
      const prefix = i > 0 ? ', ' : '';
      if (!match) {
        return (
          <React.Fragment key={i}>
            {prefix}
            {part.trim()}
          </React.Fragment>
        );
      }
      const label = normalizeKeyword(match[1]);
      const rest = match[2].replace(/,\s*$/, '');
      return (
        <React.Fragment key={i}>
          {prefix}
          <strong className={keywordClassName}>{label}</strong>
          {rest ? ` ${rest}` : ''}
        </React.Fragment>
      );
    });
  }

  return text;
}

function normalizeKeyword(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'as an') return 'As an';
  if (lower === 'as a') return 'As a';
  if (lower === 'i want' || lower === 'i need') return 'I want';
  if (lower === 'so that') return 'So that';
  return raw;
}
