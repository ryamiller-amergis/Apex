import { useMemo } from 'react';
import type { ChatMessage } from '../../shared/types/chat';
import {
  MODEL_CONTEXT_TOKEN_LIMITS,
  DEFAULT_CONTEXT_TOKEN_LIMIT,
} from '../../shared/config/contextLimits';

export const WARNING_THRESHOLD = 0.8;
export const WRAP_UP_THRESHOLD = 0.9;
export const CRITICAL_THRESHOLD = 0.95;

export interface ContextEstimate {
  estimatedTokens: number;
  contextLimit: number;
  usagePercent: number;
  isWarning: boolean;
  /** True at 90%+ — signals the user should consider wrapping up */
  isNearLimit: boolean;
  /** True at 95%+ — signals the context window is nearly full */
  isCritical: boolean;
  /** Human-friendly token label, e.g. "42k" or "850" */
  label: string;
}

/**
 * Estimates context-window usage using a chars/4 heuristic.
 *
 * @param messages          Conversation messages (text + persisted attachment sizes)
 * @param inputText         Current draft input text
 * @param streamingText     In-flight streaming response text
 * @param model             Active model id (used to look up the context limit)
 * @param draftAttachmentChars  Total character count of draft attachments not yet sent
 */
export function useContextEstimate(
  messages: ChatMessage[],
  inputText: string,
  streamingText: string,
  model: string,
  draftAttachmentChars = 0,
): ContextEstimate {
  const contextLimit = MODEL_CONTEXT_TOKEN_LIMITS[model] ?? DEFAULT_CONTEXT_TOKEN_LIMIT;

  const estimatedTokens = useMemo(() => {
    const messageChars = messages.reduce((sum, msg) => {
      const attachChars = msg.attachments?.reduce(
        (aSum, a) => aSum + a.size,
        0,
      ) ?? 0;
      return sum + msg.text.length + attachChars;
    }, 0);
    const draftChars = inputText.length + draftAttachmentChars;
    const streamChars = streamingText.length;
    return Math.ceil((messageChars + draftChars + streamChars) / 4);
  }, [messages, inputText, draftAttachmentChars, streamingText]);

  const usagePercent = Math.min(100, Math.round((estimatedTokens / contextLimit) * 100));
  const isWarning = usagePercent >= WARNING_THRESHOLD * 100;
  const isNearLimit = usagePercent >= WRAP_UP_THRESHOLD * 100;
  const isCritical = usagePercent >= CRITICAL_THRESHOLD * 100;
  const label = estimatedTokens >= 1000
    ? `${Math.round(estimatedTokens / 1000)}k`
    : `${estimatedTokens}`;

  return { estimatedTokens, contextLimit, usagePercent, isWarning, isNearLimit, isCritical, label };
}
