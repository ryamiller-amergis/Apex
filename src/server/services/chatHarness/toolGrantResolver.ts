/**
 * Shared ADO tool grant resolution and attachment validation for chat harness commands.
 *
 * Mirrors the ADO token and attachment validation rules in `routes/chat.ts` so
 * socket and HTTP harness commands share one implementation. Refreshes tokens
 * from `adoStoredUserToken.ts` when no request-scoped token is supplied.
 */
import type { ChatAttachment } from '../../../shared/types/chat';
import type { HarnessAreaId } from '../../../shared/types/chatHarness';
import type { FrozenInteractiveToolGrant } from '../../../shared/types/durableInteractiveTurn';
import { getStoredAdoTokenForUser } from '../adoStoredUserToken';
import type { DurableInteractiveToolGrantInput } from '../durableInteractiveTurnService';
import {
  encryptInteractiveToolGrant,
  type EncryptInteractiveToolGrantInput,
} from '../interactiveToolGrantCrypto';

export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;

const DEFAULT_TOOL_GRANT_TTL_MS = 60 * 60 * 1000;

type AllowedOperation = FrozenInteractiveToolGrant['allowedOperations'][number];

const AREAS_REQUIRING_ADO_TOKEN: ReadonlySet<HarnessAreaId> = new Set<HarnessAreaId>([
  'calendar-work-item',
  'cab-release',
]);

export function areaRequiresAdoToken(area: HarnessAreaId): boolean {
  return AREAS_REQUIRING_ADO_TOKEN.has(area);
}

export interface ResolveHarnessToolGrantInput {
  userId: string;
  projectId: string;
  area: HarnessAreaId;
  requiresAdoToken?: boolean;
  requestToken?: string | null;
  allowedOperations?: ReadonlyArray<AllowedOperation>;
}

export interface ResolveHarnessToolGrantDeps {
  getStoredAdoToken?: (userId: string) => Promise<string | null>;
  encryptToolGrant?: (
    input: EncryptInteractiveToolGrantInput,
  ) => FrozenInteractiveToolGrant;
  now?: () => Date;
}

export type ResolveHarnessToolGrantResult =
  | {
      ok: true;
      toolGrant: FrozenInteractiveToolGrant | null;
      toolGrantInput?: DurableInteractiveToolGrantInput;
    }
  | {
      ok: false;
      reason: 'Sign in again to continue';
    };

/**
 * Resolve an optional or required per-user Azure DevOps tool grant for a
 * harness command. Never logs token values.
 */
export async function resolveHarnessToolGrant(
  input: ResolveHarnessToolGrantInput,
  deps?: ResolveHarnessToolGrantDeps,
): Promise<ResolveHarnessToolGrantResult> {
  const requiresToken =
    input.requiresAdoToken === true || areaRequiresAdoToken(input.area);
  const trimmedRequestToken =
    typeof input.requestToken === 'string' && input.requestToken.trim().length > 0
      ? input.requestToken.trim()
      : null;

  if (!requiresToken && !trimmedRequestToken) {
    return { ok: true, toolGrant: null };
  }

  const loadStoredToken = deps?.getStoredAdoToken ?? getStoredAdoTokenForUser;
  let token = trimmedRequestToken;
  if (!token) {
    try {
      const stored = await loadStoredToken(input.userId);
      token =
        typeof stored === 'string' && stored.trim().length > 0
          ? stored.trim()
          : null;
    } catch {
      token = null;
    }
  }

  if (!token) {
    if (requiresToken) {
      return { ok: false, reason: 'Sign in again to continue' };
    }
    return { ok: true, toolGrant: null };
  }

  const allowedOperations: ReadonlyArray<AllowedOperation> =
    input.allowedOperations && input.allowedOperations.length > 0
      ? input.allowedOperations
      : ['ado:read', 'ado:write'];
  const now = deps?.now ?? (() => new Date());
  const expiresAt = new Date(now().getTime() + DEFAULT_TOOL_GRANT_TTL_MS).toISOString();
  const encrypt = deps?.encryptToolGrant ?? encryptInteractiveToolGrant;

  const toolGrant = encrypt({
    userId: input.userId,
    projectId: input.projectId,
    allowedOperations,
    delegatedAdoToken: token,
    expiresAt,
  });

  return {
    ok: true,
    toolGrant,
    toolGrantInput: {
      allowedOperations,
      delegatedAdoToken: token,
    },
  };
}

export type ValidateHarnessAttachmentsResult =
  | { ok: true; attachments: ChatAttachment[] }
  | { ok: false; code: string; message: string; statusCode: 400 | 413 };

/**
 * Validate `send` command attachments against the same limits enforced by
 * `routes/chat.ts`.
 */
export function validateHarnessAttachments(
  raw: unknown,
): ValidateHarnessAttachmentsResult {
  if (raw === undefined) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'invalid-attachments',
      message: 'attachments must be an array',
      statusCode: 400,
    };
  }
  if (raw.length > MAX_CHAT_ATTACHMENTS) {
    return {
      ok: false,
      code: 'too-many-attachments',
      message: `up to ${MAX_CHAT_ATTACHMENTS} attachments are allowed`,
      statusCode: 413,
    };
  }

  let totalBytes = 0;
  const validated: ChatAttachment[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index] as Partial<ChatAttachment> | null | undefined;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.id !== 'string' ||
      candidate.id.trim().length === 0 ||
      typeof candidate.name !== 'string' ||
      candidate.name.trim().length === 0 ||
      typeof candidate.content !== 'string'
    ) {
      return {
        ok: false,
        code: 'invalid-attachments',
        message: `attachment ${index + 1} is invalid`,
        statusCode: 400,
      };
    }
    if (candidate.encoding !== undefined && candidate.encoding !== 'base64') {
      return {
        ok: false,
        code: 'invalid-attachments',
        message: `attachment ${candidate.name} has an invalid encoding`,
        statusCode: 400,
      };
    }
    const size = Number(candidate.size);
    if (!Number.isFinite(size) || size < 0) {
      return {
        ok: false,
        code: 'invalid-attachments',
        message: `attachment ${candidate.name} has an invalid size`,
        statusCode: 400,
      };
    }
    if (size > MAX_CHAT_ATTACHMENT_BYTES) {
      return {
        ok: false,
        code: 'attachment-too-large',
        message: `attachment ${candidate.name} is too large`,
        statusCode: 413,
      };
    }
    totalBytes += size;
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      return {
        ok: false,
        code: 'attachments-too-large',
        message: 'attachments are too large',
        statusCode: 413,
      };
    }
    validated.push({
      id: candidate.id,
      name: candidate.name,
      type: typeof candidate.type === 'string' ? candidate.type : 'text/plain',
      size,
      content: candidate.content,
      ...(candidate.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
    });
  }

  return { ok: true, attachments: validated };
}
