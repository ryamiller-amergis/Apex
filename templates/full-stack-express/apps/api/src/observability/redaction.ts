import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Keys whose values are identity data (BR-007). Redaction is key-based: a
 * value interpolated into a message string is not caught, so never build log
 * messages from identity values.
 */
export const IDENTITY_FIELD_NAMES = [
  'displayName',
  'display_name',
  'email',
  'externalSubject',
  'external_subject',
  'subject',
  'sub',
] as const;

export const REDACTED = '[Redacted]';

const MAX_REDACTION_DEPTH = 3;

export const REDACT_PATHS: string[] = IDENTITY_FIELD_NAMES.flatMap((name) =>
  Array.from(
    { length: MAX_REDACTION_DEPTH + 1 },
    (_, depth) => `${'*.'.repeat(depth)}${name}`
  )
);

export interface SerializedError {
  type: string;
  code?: string | number;
  message?: string;
  stack?: string;
}

/**
 * Keeps type, code, message, and stack. Drops everything else, including the
 * PostgreSQL fields detail, where, parameters, and query text, because a
 * unique violation puts the offending value in detail. The cause chain is
 * dropped for the same reason.
 */
export function serializeError(value: unknown): SerializedError {
  if (!(value instanceof Error)) {
    return typeof value === 'string'
      ? { type: 'string', message: value }
      : { type: value === null ? 'null' : typeof value };
  }
  const serialized: SerializedError = {
    type: value.name || value.constructor.name,
    message: value.message,
  };
  const code = (value as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    serialized.code = code;
  }
  if (value.stack) {
    serialized.stack = value.stack;
  }
  return serialized;
}

export function requestPath(req: IncomingMessage): string {
  const url =
    (req as IncomingMessage & { originalUrl?: string }).originalUrl ??
    req.url ??
    '';
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

export function serializeRequest(req: IncomingMessage): {
  method?: string;
  path: string;
} {
  return { method: req.method, path: requestPath(req) };
}

export function serializeResponse(res: ServerResponse): {
  statusCode: number;
} {
  return { statusCode: res.statusCode };
}
