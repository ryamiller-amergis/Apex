/**
 * W3C traceparent helpers for browser correlation and ingest validation.
 * IDs are 32/16 lowercase hex; all-zero values are rejected.
 */
import { W3C_TRACE_ID_PATTERN } from '../types/observability';

export const W3C_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
export const W3C_TRACEPARENT_VERSION = '00';
const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);
const TRACEPARENT_RE =
  /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;

export function generateHexId(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteCount; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateTraceId(): string {
  let id = generateHexId(16);
  if (id === ALL_ZERO_TRACE_ID) id = generateHexId(16);
  return id === ALL_ZERO_TRACE_ID ? '4bf92f3577b34da6a3ce929d0e0e4736' : id;
}

export function generateSpanId(): string {
  let id = generateHexId(8);
  if (id === ALL_ZERO_SPAN_ID) id = generateHexId(8);
  return id === ALL_ZERO_SPAN_ID ? '00f067aa0ba902b7' : id;
}

export function isValidTraceId(value: unknown): value is string {
  return typeof value === 'string' && W3C_TRACE_ID_PATTERN.test(value) && value !== ALL_ZERO_TRACE_ID;
}

export function isValidSpanId(value: unknown): value is string {
  return typeof value === 'string' && W3C_SPAN_ID_PATTERN.test(value) && value !== ALL_ZERO_SPAN_ID;
}

export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `${W3C_TRACEPARENT_VERSION}-${traceId}-${spanId}-${flags}`;
}

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(value: unknown): ParsedTraceparent | null {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return null;
  const version = match[1]!.toLowerCase();
  const traceId = match[2]!.toLowerCase();
  const spanId = match[3]!.toLowerCase();
  const flags = match[4]!.toLowerCase();
  if (version !== W3C_TRACEPARENT_VERSION) return null;
  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return null;
  return { version, traceId, spanId, flags };
}

export function hasValidTraceparent(headers: Headers | Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const value =
    headers instanceof Headers
      ? headers.get('traceparent')
      : headers.traceparent ?? headers.Traceparent;
  return parseTraceparent(value) !== null;
}
