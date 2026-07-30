import { useEffect, useState } from 'react';

/**
 * Returns `value` delayed by `delayMs` (default 300ms).
 * Used by chat history search so the query key does not thrash on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timerId = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timerId);
  }, [value, delayMs]);

  return debounced;
}
