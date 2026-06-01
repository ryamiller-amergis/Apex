import { renderHook } from '@testing-library/react';
import {
  useContextEstimate,
  WARNING_THRESHOLD,
  WRAP_UP_THRESHOLD,
  CRITICAL_THRESHOLD,
} from '../useContextEstimate';
import {
  MODEL_CONTEXT_TOKEN_LIMITS,
  DEFAULT_CONTEXT_TOKEN_LIMIT,
} from '../../../shared/config/contextLimits';
import type { ChatMessage } from '../../../shared/types/chat';

function msg(text: string, attachments?: { size: number }[]): ChatMessage {
  return {
    id: String(Math.random()),
    role: 'user',
    text,
    ts: new Date().toISOString(),
    attachments: attachments?.map((a) => ({
      id: String(Math.random()),
      name: 'file.txt',
      type: 'text/plain',
      size: a.size,
    })),
  };
}

// ── Basic token estimation ──────────────────────────────────────────────────

describe('useContextEstimate', () => {
  describe('token estimation (chars / 4)', () => {
    it('estimates tokens as ceil(totalChars / 4)', () => {
      const messages = [msg('hello')]; // 5 chars
      const { result } = renderHook(() =>
        useContextEstimate(messages, '', '', 'composer-2'),
      );

      expect(result.current.estimatedTokens).toBe(Math.ceil(5 / 4));
    });

    it('includes input text in the estimate', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], 'abcdefgh', '', 'composer-2'),
      );

      expect(result.current.estimatedTokens).toBe(Math.ceil(8 / 4));
    });

    it('includes streaming text in the estimate', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], '', 'abcdefghijkl', 'composer-2'),
      );

      expect(result.current.estimatedTokens).toBe(Math.ceil(12 / 4));
    });

    it('includes draft attachment chars in the estimate', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], '', '', 'composer-2', 400),
      );

      expect(result.current.estimatedTokens).toBe(Math.ceil(400 / 4));
    });

    it('sums message text, message attachment sizes, input, streaming, and draft attachments', () => {
      const messages = [
        msg('hi', [{ size: 100 }]), // 2 + 100 = 102 chars
        msg('bye'),                 // 3 chars
      ];
      const inputText = 'draft';         // 5 chars
      const streamingText = 'stream';    // 6 chars
      const draftAttachChars = 50;

      // total = 102 + 3 + 5 + 50 + 6 = 166 → ceil(166/4) = 42
      const { result } = renderHook(() =>
        useContextEstimate(messages, inputText, streamingText, 'composer-2', draftAttachChars),
      );

      expect(result.current.estimatedTokens).toBe(Math.ceil(166 / 4));
    });

    it('returns 0 tokens when all inputs are empty', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], '', '', 'composer-2'),
      );

      expect(result.current.estimatedTokens).toBe(0);
    });
  });

  // ── Context limit lookup ────────────────────────────────────────────────────

  describe('context limit lookup', () => {
    it('uses the model-specific limit for a known model', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], '', '', 'gemini-3.1-pro'),
      );

      expect(result.current.contextLimit).toBe(MODEL_CONTEXT_TOKEN_LIMITS['gemini-3.1-pro']);
    });

    it('falls back to DEFAULT_CONTEXT_TOKEN_LIMIT for unknown models', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], '', '', 'unknown-model-xyz'),
      );

      expect(result.current.contextLimit).toBe(DEFAULT_CONTEXT_TOKEN_LIMIT);
    });
  });

  // ── Threshold flags ─────────────────────────────────────────────────────────

  describe('threshold flags', () => {
    function hookAtPercent(targetPercent: number) {
      const limit = DEFAULT_CONTEXT_TOKEN_LIMIT; // 200_000
      const neededTokens = Math.round((targetPercent / 100) * limit);
      const chars = neededTokens * 4;
      return renderHook(() =>
        useContextEstimate([], 'x'.repeat(chars), '', 'composer-2'),
      );
    }

    it('isWarning is false below 80%', () => {
      const { result } = hookAtPercent(79);
      expect(result.current.isWarning).toBe(false);
    });

    it('isWarning is true at 80%', () => {
      const { result } = hookAtPercent(80);
      expect(result.current.isWarning).toBe(true);
    });

    it('isNearLimit is false below 90%', () => {
      const { result } = hookAtPercent(89);
      expect(result.current.isNearLimit).toBe(false);
    });

    it('isNearLimit is true at 90%', () => {
      const { result } = hookAtPercent(90);
      expect(result.current.isNearLimit).toBe(true);
    });

    it('isCritical is false below 95%', () => {
      const { result } = hookAtPercent(94);
      expect(result.current.isCritical).toBe(false);
    });

    it('isCritical is true at 95%', () => {
      const { result } = hookAtPercent(95);
      expect(result.current.isCritical).toBe(true);
    });

    it('all flags are true when over 95%', () => {
      const { result } = hookAtPercent(99);
      expect(result.current.isWarning).toBe(true);
      expect(result.current.isNearLimit).toBe(true);
      expect(result.current.isCritical).toBe(true);
    });
  });

  // ── usagePercent capping ──────────────────────────────────────────────────

  describe('usagePercent', () => {
    it('is capped at 100 even when tokens exceed the limit', () => {
      const limit = DEFAULT_CONTEXT_TOKEN_LIMIT;
      const chars = (limit + 50_000) * 4;

      const { result } = renderHook(() =>
        useContextEstimate([], 'x'.repeat(chars), '', 'composer-2'),
      );

      expect(result.current.usagePercent).toBe(100);
    });

    it('rounds to the nearest integer', () => {
      // 200_000 * 0.333 = 66_600 tokens → 66_600/200_000 = 33.3% → rounds to 33
      const chars = 66_600 * 4;
      const { result } = renderHook(() =>
        useContextEstimate([], 'x'.repeat(chars), '', 'composer-2'),
      );

      expect(result.current.usagePercent).toBe(33);
    });
  });

  // ── Label formatting ────────────────────────────────────────────────────────

  describe('label formatting', () => {
    it('formats large values with "k" suffix', () => {
      const chars = 42_000 * 4; // 42k tokens
      const { result } = renderHook(() =>
        useContextEstimate([], 'x'.repeat(chars), '', 'composer-2'),
      );

      expect(result.current.label).toBe('42k');
    });

    it('formats small values as plain number', () => {
      const chars = 850 * 4; // 850 tokens
      const { result } = renderHook(() =>
        useContextEstimate([], 'x'.repeat(chars), '', 'composer-2'),
      );

      expect(result.current.label).toBe('850');
    });

    it('formats exactly 1000 tokens with "k" suffix', () => {
      const chars = 1000 * 4;
      const { result } = renderHook(() =>
        useContextEstimate([], 'x'.repeat(chars), '', 'composer-2'),
      );

      expect(result.current.label).toBe('1k');
    });

    it('returns "0" for empty input', () => {
      const { result } = renderHook(() =>
        useContextEstimate([], '', '', 'composer-2'),
      );

      expect(result.current.label).toBe('0');
    });
  });

  // ── Exported threshold constants ──────────────────────────────────────────

  describe('threshold constants', () => {
    it('WARNING_THRESHOLD is 0.8', () => {
      expect(WARNING_THRESHOLD).toBe(0.8);
    });

    it('WRAP_UP_THRESHOLD is 0.9', () => {
      expect(WRAP_UP_THRESHOLD).toBe(0.9);
    });

    it('CRITICAL_THRESHOLD is 0.95', () => {
      expect(CRITICAL_THRESHOLD).toBe(0.95);
    });
  });
});
