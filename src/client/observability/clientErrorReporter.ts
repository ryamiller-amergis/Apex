type BrowserErrorReporter = (error: unknown, kind: 'boundary' | 'window' | 'rejection') => void;

let reporter: BrowserErrorReporter | null = null;

export function setBrowserErrorReporter(next: BrowserErrorReporter | null): void {
  reporter = next;
}

export function reportCaughtClientError(error: unknown, kind: 'boundary' | 'window' | 'rejection' = 'boundary'): void {
  try {
    reporter?.(error, kind);
  } catch {
    // Reporting must never affect error recovery.
  }
}
