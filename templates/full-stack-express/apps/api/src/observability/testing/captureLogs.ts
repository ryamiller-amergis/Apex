export interface LogCapture {
  stream: { write(chunk: string): void };
  raw(): string[];
  lines(): Record<string, unknown>[];
}

export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    raw() {
      return chunks.join('').split('\n').filter(Boolean);
    },
    lines() {
      return this.raw().map(
        (line) => JSON.parse(line) as Record<string, unknown>
      );
    },
  };
}
