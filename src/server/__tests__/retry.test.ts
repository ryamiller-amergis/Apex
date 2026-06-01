import { retryWithBackoff, sleep } from '../utils/retry';

describe('Retry Utility', () => {
  describe('retryWithBackoff', () => {
    it('should return result on first successful attempt', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      const result = await retryWithBackoff(mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on 429 status code', async () => {
      const error = new Error('Rate limited');
      (error as any).statusCode = 429;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(mockFn, 3, 1); // Use 1ms delay for speed

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should retry on 5xx status codes', async () => {
      const error500 = new Error('Server error');
      (error500 as any).statusCode = 500;

      const error503 = new Error('Service unavailable');
      (error503 as any).statusCode = 503;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error500)
        .mockRejectedValueOnce(error503)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(mockFn, 3, 1); // Use 1ms delay for speed

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should use exponential backoff for retries', async () => {
      const error = new Error('Rate limited');
      (error as any).statusCode = 429;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const startTime = Date.now();
      await retryWithBackoff(mockFn, 3, 10); // Use 10ms as base delay
      const elapsed = Date.now() - startTime;

      // First retry: 10ms, Second retry: 20ms = ~30ms total minimum
      expect(elapsed).toBeGreaterThanOrEqual(25); // Allow some variance
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should throw non-retryable errors immediately', async () => {
      const error = new Error('Bad request');
      (error as any).statusCode = 400;

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(mockFn)).rejects.toThrow('Bad request');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retries exhausted', async () => {
      const error = new Error('Rate limited');
      (error as any).statusCode = 429;

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(mockFn, 3, 1)).rejects.toThrow('Rate limited');
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('should handle errors with status property', async () => {
      const error = new Error('Server error');
      (error as any).status = 500;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(mockFn, 3, 1); // Use 1ms delay for speed

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should use default maxRetries and initialDelay', async () => {
      const error = new Error('Rate limited');
      (error as any).statusCode = 429;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should handle errors without status code', async () => {
      const error = new Error('Generic error');

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(mockFn)).rejects.toThrow('Generic error');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Options-object overload ─────────────────────────────────────────────────

  describe('retryWithBackoff (options object)', () => {
    it('accepts an options object with maxRetries and initialDelay', async () => {
      const error = new Error('Server error');
      (error as any).statusCode = 500;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('done');

      const result = await retryWithBackoff(mockFn, {
        maxRetries: 2,
        initialDelay: 1,
      });

      expect(result).toBe('done');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('defaults maxRetries to 3 when using empty options', async () => {
      const error = new Error('Server error');
      (error as any).statusCode = 500;

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(mockFn, { initialDelay: 1, jitter: false }),
      ).rejects.toThrow();
      expect(mockFn).toHaveBeenCalledTimes(3);
    });
  });

  // ── Jitter ──────────────────────────────────────────────────────────────────

  describe('jitter', () => {
    it('adds randomness to delay when jitter is enabled', async () => {
      const error = new Error('Retry me');
      (error as any).statusCode = 500;

      const delays: number[] = [];
      const originalRandom = Math.random;
      let callCount = 0;
      Math.random = () => {
        callCount++;
        return callCount === 1 ? 0.0 : 1.0;
      };

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue('ok');

      const start = Date.now();
      await retryWithBackoff(mockFn, {
        maxRetries: 3,
        initialDelay: 20,
        jitter: true,
      });

      Math.random = originalRandom;
      expect(mockFn).toHaveBeenCalledTimes(3);
    });

    it('does not apply jitter for legacy positional args', async () => {
      const error = new Error('Retry me');
      (error as any).statusCode = 500;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('ok');

      const start = Date.now();
      await retryWithBackoff(mockFn, 3, 50);
      const elapsed = Date.now() - start;

      // Without jitter, delay = exactly 50ms (no randomness)
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('defaults jitter to true when using options object', async () => {
      const error = new Error('Retry me');
      (error as any).statusCode = 500;

      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('ok');

      await retryWithBackoff(mockFn, { maxRetries: 2, initialDelay: 1 });

      expect(randomSpy).toHaveBeenCalled();
      randomSpy.mockRestore();
    });
  });

  // ── shouldRetry predicate ───────────────────────────────────────────────────

  describe('shouldRetry predicate', () => {
    it('retries when shouldRetry returns true', async () => {
      const error = new Error('Custom retryable');

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('recovered');

      const result = await retryWithBackoff(mockFn, {
        maxRetries: 2,
        initialDelay: 1,
        shouldRetry: () => true,
        jitter: false,
      });

      expect(result).toBe('recovered');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('does not retry when shouldRetry returns false', async () => {
      const error = new Error('No retry');

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(mockFn, {
          maxRetries: 5,
          initialDelay: 1,
          shouldRetry: () => false,
          jitter: false,
        }),
      ).rejects.toThrow('No retry');

      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('receives the thrown error as its argument', async () => {
      const error = new Error('Check me');
      const predicate = jest.fn().mockReturnValue(false);

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(mockFn, {
          maxRetries: 2,
          initialDelay: 1,
          shouldRetry: predicate,
          jitter: false,
        }),
      ).rejects.toThrow();

      expect(predicate).toHaveBeenCalledWith(error);
    });
  });

  // ── CursorAgentError handling ───────────────────────────────────────────────

  describe('CursorAgentError handling', () => {
    function makeCursorAgentError(
      message: string,
      isRetryable?: boolean,
    ): Error & { isRetryable?: boolean } {
      const err = new Error(message) as Error & { isRetryable?: boolean };
      err.isRetryable = isRetryable;
      return err;
    }

    it('retries when CursorAgentError has isRetryable === true', async () => {
      const error = makeCursorAgentError('Transient agent error', true);

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('recovered');

      const result = await retryWithBackoff(mockFn, {
        maxRetries: 2,
        initialDelay: 1,
        jitter: false,
      });

      expect(result).toBe('recovered');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('throws immediately when CursorAgentError has isRetryable === false', async () => {
      const error = makeCursorAgentError('Fatal agent error', false);

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(mockFn, {
          maxRetries: 5,
          initialDelay: 1,
          jitter: false,
        }),
      ).rejects.toThrow('Fatal agent error');

      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('falls through to shouldRetry when isRetryable is undefined', async () => {
      const error = makeCursorAgentError('Ambiguous error', undefined);
      (error as any).statusCode = 500;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(mockFn, {
        maxRetries: 2,
        initialDelay: 1,
        jitter: false,
      });

      expect(result).toBe('ok');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('isRetryable === true takes precedence over shouldRetry returning false', async () => {
      const error = makeCursorAgentError('Forced retry', true);

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(mockFn, {
        maxRetries: 2,
        initialDelay: 1,
        shouldRetry: () => false,
        jitter: false,
      });

      expect(result).toBe('ok');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('isRetryable === false takes precedence over shouldRetry returning true', async () => {
      const error = makeCursorAgentError('No retries allowed', false);

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(mockFn, {
          maxRetries: 5,
          initialDelay: 1,
          shouldRetry: () => true,
          jitter: false,
        }),
      ).rejects.toThrow('No retries allowed');

      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  // ── Backward compatibility ──────────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('works with no optional arguments', async () => {
      const mockFn = jest.fn().mockResolvedValue('ok');
      const result = await retryWithBackoff(mockFn);
      expect(result).toBe('ok');
    });

    it('works with positional maxRetries only', async () => {
      const error = new Error('fail');
      (error as any).statusCode = 500;
      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(mockFn, 2)).rejects.toThrow();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('works with positional maxRetries and initialDelay', async () => {
      const error = new Error('fail');
      (error as any).statusCode = 500;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(mockFn, 3, 1);
      expect(result).toBe('ok');
    });
  });

  // ── Max retries respected ───────────────────────────────────────────────────

  describe('max retries enforcement', () => {
    it('stops retrying after maxRetries attempts with options object', async () => {
      const error = new Error('Always fails');
      (error as any).statusCode = 500;

      const mockFn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(mockFn, { maxRetries: 4, initialDelay: 1, jitter: false }),
      ).rejects.toThrow('Always fails');

      expect(mockFn).toHaveBeenCalledTimes(4);
    });

    it('returns the value on a successful retry within max attempts', async () => {
      const error = new Error('Temporary');
      (error as any).statusCode = 500;

      const mockFn = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValue(42);

      const result = await retryWithBackoff(mockFn, {
        maxRetries: 5,
        initialDelay: 1,
        jitter: false,
      });

      expect(result).toBe(42);
      expect(mockFn).toHaveBeenCalledTimes(3);
    });
  });

  describe('sleep', () => {
    it('should resolve after specified milliseconds', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow small variance
      expect(elapsed).toBeLessThan(100);
    });
  });
});
