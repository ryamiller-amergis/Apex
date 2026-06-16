import type { ChatMessage, ChatThreadSummary } from '../types/chat';

/** Human-readable process name from a skill repo path (e.g. `grill-with-docs`). */
export function skillPathToProcessLabel(skillPath: string): string {
  const parts = skillPath.split('/');
  const skillFolder = parts[parts.length - 2] ?? parts[parts.length - 1] ?? 'Skill';
  return skillFolder.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Normalize a user message into a short history subtitle. */
export function normalizeMessagePreview(text?: string | null): string | undefined {
  if (!text) return undefined;
  const trimmed = text.replace(/\n/g, ' ').trim();
  if (!trimmed || trimmed === 'Begin.') return undefined;
  // Bare /skill slug with no follow-up text — not a useful preview.
  if (/^\/\S+$/.test(trimmed)) return undefined;
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

/** First visible user message suitable for a history subtitle. */
export function firstUserMessagePreview(
  messages: Pick<ChatMessage, 'role' | 'text' | 'hidden'>[],
): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user' || m.hidden) continue;
    const preview = normalizeMessagePreview(m.text);
    if (preview) return preview;
  }
  return undefined;
}

/** `{process} - {description}` when description is present. */
export function formatProcessDescription(
  process: string,
  description?: string | null,
  maxLen = 120,
): string {
  const trimmed = description?.trim();
  const label = trimmed ? `${process} - ${trimmed}` : process;
  return label.length > maxLen ? `${label.slice(0, maxLen - 1)}…` : label;
}

/** Label shown in the thread history sidebar. */
export function formatThreadHistoryLabel(
  thread: Pick<ChatThreadSummary, 'title' | 'kickoff' | 'messagePreview'>,
  maxLen = 120,
): string {
  const { pillLabel, pillDescription, skillPath } = thread.kickoff;
  const promptPreview = thread.messagePreview;

  if (pillLabel) {
    const desc = promptPreview || pillDescription?.trim();
    if (desc) return formatProcessDescription(pillLabel, desc, maxLen);
    // messagePreview may be absent (stale title, ORM quirk); extract description
    // from the stored title which deriveTitle already computed as "Label - desc".
    const prefix = `${pillLabel} - `;
    if (thread.title.startsWith(prefix) && thread.title.length > prefix.length) {
      return thread.title.length > maxLen ? `${thread.title.slice(0, maxLen - 1)}…` : thread.title;
    }
    return pillLabel;
  }

  if (skillPath) {
    const process = skillPathToProcessLabel(skillPath);
    if (promptPreview) return formatProcessDescription(process, promptPreview, maxLen);
    const prefix = `${process} - `;
    if (thread.title.startsWith(prefix) && thread.title.length > prefix.length) {
      return thread.title.length > maxLen ? `${thread.title.slice(0, maxLen - 1)}…` : thread.title;
    }
    return process;
  }

  return thread.title;
}
