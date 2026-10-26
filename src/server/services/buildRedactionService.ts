/**
 * Pure redaction step. No database import, so evidence, pull-request, and
 * notification writers can call it without pulling in Drizzle.
 */

const MAX_INPUT_CHARS = 2 * 1024 * 1024;
const KNOWN_SENTINEL = '\u0000KNOWN\u0000';

const NAMED_SECRET_ENVS = [
  'CURSOR_API_KEY',
  'AI_RUNS_RUNNER_CALLBACK_TOKEN',
  'LT_RUNNER_CALLBACK_TOKEN',
] as const;

const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD|PAT|CONNECTION_STRING/i;

const SECRET_KEY_NAME = /(?:^|[^a-z0-9])(?:api[_-]?key|client[_-]?secret|password|secret|token|pat|connection[_-]?string)$/i;

/**
 * One linear pass. Each alternative is bounded: no nested quantifiers.
 * Named groups tell the replacer which class matched.
 */
const SECRET_PATTERN = new RegExp(
  [
    '(?<bearer>\\bBearer\\s+[A-Za-z0-9\\-._~+/]{8,}=*)',
    '(?<jwt>eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})',
    '(?<connUrl>\\b(?:postgres|postgresql|mysql|mongodb(?:\\+srv)?|redis|rediss|amqp|amqps):\\/\\/\\S+)',
    '(?<ado>Server=[^\\n;]{1,200}(?:;[^\\n;]{1,200}){0,12};Password=[^\\s;]{1,200})',
    '(?<account>AccountKey=[A-Za-z0-9+/=]{8,})',
    '(?<pem>-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\\r\\n]{1,16384}-----END [A-Z ]{0,40}PRIVATE KEY-----)',
    '(?<kv>(?:api[_-]?key|client[_-]?secret|password|secret|token|pat|connection[_-]?string)\\s*[:=]\\s*["\']?[^\\s"\',}]{1,500})',
  ].join('|'),
  'gi',
);

export type KnownSecretSource = () => readonly string[];

export class RedactionError extends Error {
  readonly code = 'REDACTION_UNPROCESSABLE' as const;

  constructor() {
    super('Redaction cannot process this input');
    this.name = 'RedactionError';
  }
}

export interface RedactOptions {
  knownSecrets?: KnownSecretSource;
}

export function knownSecretsFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    const named = (NAMED_SECRET_ENVS as readonly string[]).includes(name);
    if (named || SECRET_ENV_NAME.test(name)) values.push(value);
  }
  return values;
}

export function defaultKnownSecrets(): readonly string[] {
  return knownSecretsFromEnv(process.env);
}

function assertString(input: unknown): asserts input is string {
  if (typeof input !== 'string') throw new RedactionError();
  if (input.length > MAX_INPUT_CHARS) throw new RedactionError();
}

function placeholderFor(groups: Record<string, string | undefined> | undefined): string {
  if (groups?.bearer) return '[REDACTED:bearer-token]';
  if (groups?.jwt) return '[REDACTED:jwt]';
  if (groups?.connUrl || groups?.ado || groups?.account) return '[REDACTED:connection-string]';
  if (groups?.pem) return '[REDACTED:private-key]';
  return '[REDACTED:secret-key]';
}

function applyKnownSecrets(input: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 8 && !secret.includes('\u0000')))];
  unique.sort((left, right) => right.length - left.length);
  let output = input;
  for (const secret of unique) {
    if (!output.includes(secret)) continue;
    output = output.split(secret).join(KNOWN_SENTINEL);
  }
  return output;
}

export function redactText(input: string, options?: RedactOptions): string {
  assertString(input);
  const secrets = options?.knownSecrets?.() ?? defaultKnownSecrets();
  const withKnown = applyKnownSecrets(input, secrets);
  SECRET_PATTERN.lastIndex = 0;
  const patterned = withKnown.replace(SECRET_PATTERN, (...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined> | undefined;
    return placeholderFor(groups);
  });
  return patterned.split(KNOWN_SENTINEL).join('[REDACTED:known-secret]');
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAME.test(key);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redactJson<T>(value: T, options?: RedactOptions): T {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new RedactionError();
  }
  const seen = new WeakSet<object>();

  function walk(current: unknown): unknown {
    if (typeof current === 'string') {
      assertString(current);
      return redactText(current, options);
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new RedactionError();
      seen.add(current);
      return current.map((entry) => walk(entry));
    }
    if (current && typeof current === 'object') {
      if (!isPlainObject(current)) throw new RedactionError();
      if (seen.has(current)) throw new RedactionError();
      seen.add(current);
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        next[key] = isSecretKey(key) ? '[REDACTED:secret-key]' : walk(entry);
      }
      return next;
    }
    throw new RedactionError();
  }

  return walk(value) as T;
}
