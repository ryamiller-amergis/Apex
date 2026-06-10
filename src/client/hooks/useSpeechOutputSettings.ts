import { useCallback, useEffect, useState } from 'react';

const LS_RATE_KEY = 'speechOutputRate';
export const SPEECH_OUTPUT_MIN_RATE = 0.5;
export const SPEECH_OUTPUT_MAX_RATE = 2;
export const SPEECH_OUTPUT_DEFAULT_RATE = 1.1;

const rateListeners = new Set<(rate: number) => void>();

function loadStoredRate(): number {
  try {
    const raw = localStorage.getItem(LS_RATE_KEY);
    if (!raw) return SPEECH_OUTPUT_DEFAULT_RATE;
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(SPEECH_OUTPUT_MAX_RATE, Math.max(SPEECH_OUTPUT_MIN_RATE, parsed));
    }
  } catch { /* ignore */ }
  return SPEECH_OUTPUT_DEFAULT_RATE;
}

let sharedRate = loadStoredRate();

function clampRate(nextRate: number): number {
  return Math.min(SPEECH_OUTPUT_MAX_RATE, Math.max(SPEECH_OUTPUT_MIN_RATE, nextRate));
}

function publishRate(rate: number): void {
  sharedRate = rate;
  for (const listener of rateListeners) {
    listener(rate);
  }
}

/**
 * Shared speech-output preferences (persisted to localStorage).
 * All instances on the page stay in sync.
 */
export function useSpeechOutputSettings() {
  const [rate, setRateState] = useState<number>(sharedRate);

  useEffect(() => {
    const listener = (nextRate: number) => setRateState(nextRate);
    rateListeners.add(listener);
    return () => {
      rateListeners.delete(listener);
    };
  }, []);

  const setRate = useCallback((nextRate: number) => {
    const clamped = clampRate(nextRate);
    try {
      localStorage.setItem(LS_RATE_KEY, String(clamped));
    } catch { /* ignore */ }
    publishRate(clamped);
  }, []);

  return {
    rate,
    setRate,
    minRate: SPEECH_OUTPUT_MIN_RATE,
    maxRate: SPEECH_OUTPUT_MAX_RATE,
  };
}
