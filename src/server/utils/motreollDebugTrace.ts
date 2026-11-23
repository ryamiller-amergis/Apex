// TEMP local debug trace (cloud agent PR author). Remove this file and its callers before committing.
import { appendFileSync, writeFileSync } from 'fs';

const TRACE_PATH = 'C:\\Users\\mojubile\\Projects\\Apex\\motreoll-local-debug.log';

try {
  writeFileSync(TRACE_PATH, `${new Date().toISOString()} [trace] started pid=${process.pid}\n`);
} catch {
  // Tracing must never break the server.
}

export function debugTrace(tag: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} [${tag}] ${JSON.stringify(data)}\n`);
  } catch {
    // Tracing must never break the server.
  }
}
