/** Cadence presets for API key expiration (BR-003). `1y` = 365 days. */
export type ApiKeyCadence = '30d' | '60d' | '90d' | '180d' | '1y' | 'none';

export const API_KEY_CADENCES: readonly ApiKeyCadence[] = [
  '30d',
  '60d',
  '90d',
  '180d',
  '1y',
  'none',
] as const;

export const DEFAULT_API_KEY_CADENCE: ApiKeyCadence = '90d';

/**
 * Public API capability scopes selectable on create/edit.
 * View + submit only — no manage/edit/delete scopes for machine credentials.
 */
export type ApiKeyScope =
  | 'flags:evaluate'
  | 'feature-requests:view'
  | 'feature-requests:submit'
  | 'standup:summary:read'
  | 'backlog:export';

export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  'flags:evaluate',
  'feature-requests:view',
  'feature-requests:submit',
  'standup:summary:read',
  'backlog:export',
] as const;

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'flags:evaluate': 'Feature flags — evaluate',
  'feature-requests:view': 'Feature requests — view',
  'feature-requests:submit': 'Feature requests — submit',
  'standup:summary:read': 'Standup — read summaries',
  'backlog:export': 'Backlog / PRD — export',
};

export const API_KEY_SCOPE_HINTS: Record<ApiKeyScope, string> = {
  'flags:evaluate': 'Read flag evaluation for this project (CI / services).',
  'feature-requests:view': 'List and read feature requests.',
  'feature-requests:submit': 'Create new feature requests.',
  'standup:summary:read': 'Read standup ceremony summaries.',
  'backlog:export': 'Export approved backlog / PRD artifacts.',
};

/** Derived lifecycle status — no separate revoked/disabled state (BR-008). */
export type ApiKeyStatus = 'active' | 'expired';

/** Sanitized metadata — never includes raw key or full hash. */
export interface ApiKeyMetadata {
  id: string;
  shortId: string;
  name: string;
  maskedPrefix: string;
  cadence: ApiKeyCadence;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  status: ApiKeyStatus;
  createdAt: string;
  createdBy: string;
}

export interface CreateApiKeyInput {
  name: string;
  cadence: ApiKeyCadence;
  /** Optional; defaults to empty (ping-only connectivity). */
  scopes?: ApiKeyScope[];
}

export interface UpdateApiKeyInput {
  name?: string;
  cadence?: ApiKeyCadence;
  scopes?: ApiKeyScope[];
}

/** One-time reveal response for create / regenerate. */
export interface ApiKeyRevealResponse {
  key: ApiKeyMetadata;
  rawKey: string;
}

export interface ApiKeyListResponse {
  items: ApiKeyMetadata[];
}

export type ApiKeyValidationErrorCode =
  | 'NAME_TAKEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'LIMIT_REACHED';

export class ApiKeyValidationError extends Error {
  readonly code: ApiKeyValidationErrorCode;

  constructor(message: string, code: ApiKeyValidationErrorCode = 'VALIDATION') {
    super(message);
    this.name = 'ApiKeyValidationError';
    this.code = code;
  }
}

export function isApiKeyCadence(value: unknown): value is ApiKeyCadence {
  return typeof value === 'string' && (API_KEY_CADENCES as readonly string[]).includes(value);
}

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** Normalize + validate a scopes payload; rejects unknown or manage-class values. */
export function normalizeApiKeyScopes(raw: unknown): ApiKeyScope[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ApiKeyValidationError('Scopes must be an array', 'VALIDATION');
  }
  const out: ApiKeyScope[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isApiKeyScope(item)) {
      throw new ApiKeyValidationError(`Invalid API key scope: ${String(item)}`, 'VALIDATION');
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Resolved identity attached by requirePublicApiKey (FEAT-002 / TBI-003). */
export interface PublicApiKeyContext {
  apiKeyId: string;
  projectId: string;
  scopes: ApiKeyScope[];
}

/** Minimal success payload for GET /api/public/ping (BR-012). */
export interface PublicPingResponse {
  status: 'ok';
  projectId: string;
  timestamp: string;
}
