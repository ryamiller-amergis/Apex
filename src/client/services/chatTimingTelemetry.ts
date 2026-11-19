import { trackEvent } from './telemetry';
import { isChatAreaId, type ChatAreaId } from '../../shared/types/chatHarness';

export const CHAT_TIMING_METRICS = [
  'send_to_feedback',
  'first_token',
  'longest_gap',
  'stop',
  'reconnect_restored',
] as const;

export type ChatTimingMetric = (typeof CHAT_TIMING_METRICS)[number];

export const ALLOWLISTED_CHAT_TIMING_KEYS = [
  'area',
  'projectId',
  'threadId',
  'acquisitionMode',
  'durationMs',
  'status',
] as const;

export type AllowlistedChatTimingKey = (typeof ALLOWLISTED_CHAT_TIMING_KEYS)[number];

const ALLOWLIST_SET: ReadonlySet<string> = new Set(ALLOWLISTED_CHAT_TIMING_KEYS);

export interface ChatTimingPayload {
  area?: ChatAreaId | string | null;
  projectId?: string | null;
  threadId?: string | null;
  acquisitionMode?: 'warm' | 'resumed' | 'recreated' | string | null;
  durationMs?: number | null;
  status?: string | null;
}

/**
 * Emits `chat.timing.<metric>` through Application Insights after stripping
 * every property outside `ALLOWLISTED_CHAT_TIMING_KEYS` (PBI-003 AC-3 / TBI-004 NFR).
 * Never forwards prompt, message, steer, or summary text.
 */
export function sanitizeChatTimingProps(
  raw: Record<string, unknown>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWLIST_SET.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (key === 'durationMs') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        safe.durationMs = String(Math.round(value));
      }
      continue;
    }
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128) continue;
    if (key === 'area' && !isChatAreaId(trimmed)) continue;
    safe[key] = trimmed;
  }
  return safe;
}

export function emitChatTiming(
  metric: ChatTimingMetric,
  payload: ChatTimingPayload | Record<string, unknown>,
): void {
  const properties = sanitizeChatTimingProps(payload as Record<string, unknown>);
  trackEvent(`chat.timing.${metric}`, properties);
}
