import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { FrozenInteractiveToolGrant } from '../../shared/types/durableInteractiveTurn';

const HKDF_SALT = 'apex-interactive-tool-proxy-v1';
const HKDF_INFO = 'ado-turn-grant';
const IV_BYTES = 12;

type AllowedOperation = FrozenInteractiveToolGrant['allowedOperations'][number];

export type EncryptInteractiveToolGrantInput = Readonly<{
  userId: string;
  projectId: string;
  allowedOperations: ReadonlyArray<AllowedOperation>;
  delegatedAdoToken: string | null;
  expiresAt: string;
}>;

export type DecryptInteractiveToolGrantExpectation = Readonly<{
  userId: string;
  projectId: string;
  now?: Date;
}>;

export class InteractiveToolGrantError extends Error {
  constructor(
    readonly code:
      | 'INTERACTIVE_V2_TOOL_GRANT_UNAVAILABLE'
      | 'INTERACTIVE_V2_TOOL_GRANT_INVALID',
    readonly status: 400 | 503,
  ) {
    super(code);
    this.name = 'InteractiveToolGrantError';
  }
}

type SecretOptions = Readonly<{ secret?: string }>;

function resolveSecret(options?: SecretOptions): string {
  const secret =
    options && Object.prototype.hasOwnProperty.call(options, 'secret')
      ? options.secret
      : process.env.SESSION_SECRET;
  if (!secret?.trim()) {
    throw new InteractiveToolGrantError(
      'INTERACTIVE_V2_TOOL_GRANT_UNAVAILABLE',
      503,
    );
  }
  return secret;
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from(HKDF_SALT, 'utf8'),
      Buffer.from(HKDF_INFO, 'utf8'),
      32,
    ),
  );
}

function grantAad(input: {
  userId: string;
  projectId: string;
  allowedOperations: ReadonlyArray<AllowedOperation>;
  expiresAt: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      userId: input.userId,
      projectId: input.projectId,
      allowedOperations: input.allowedOperations,
      expiresAt: input.expiresAt,
    }),
    'utf8',
  );
}

function assertValidExpiry(expiresAt: string): number {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new InteractiveToolGrantError(
      'INTERACTIVE_V2_TOOL_GRANT_INVALID',
      400,
    );
  }
  return expiresAtMs;
}

export function encryptInteractiveToolGrant(
  input: EncryptInteractiveToolGrantInput,
  options?: SecretOptions,
): FrozenInteractiveToolGrant {
  const key = deriveKey(resolveSecret(options));
  assertValidExpiry(input.expiresAt);

  if (input.delegatedAdoToken === null) {
    return {
      userId: input.userId,
      projectId: input.projectId,
      allowedOperations: [...input.allowedOperations],
      expiresAt: input.expiresAt,
      encryptedAdoToken: null,
    };
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(grantAad(input));
  const ciphertext = Buffer.concat([
    cipher.update(input.delegatedAdoToken, 'utf8'),
    cipher.final(),
  ]);

  return {
    userId: input.userId,
    projectId: input.projectId,
    allowedOperations: [...input.allowedOperations],
    expiresAt: input.expiresAt,
    encryptedAdoToken: {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    },
  };
}

export function decryptInteractiveToolGrant(
  grant: FrozenInteractiveToolGrant,
  expectation: DecryptInteractiveToolGrantExpectation,
  options?: SecretOptions,
): string | null {
  const key = deriveKey(resolveSecret(options));
  const expiresAtMs = assertValidExpiry(grant.expiresAt);
  const now = expectation.now ?? new Date();
  if (
    grant.userId !== expectation.userId ||
    grant.projectId !== expectation.projectId ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() >= expiresAtMs
  ) {
    throw new InteractiveToolGrantError(
      'INTERACTIVE_V2_TOOL_GRANT_INVALID',
      400,
    );
  }
  if (grant.encryptedAdoToken === null) return null;

  try {
    const encrypted = grant.encryptedAdoToken;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(encrypted.iv, 'base64'),
    );
    decipher.setAAD(grantAad(grant));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new InteractiveToolGrantError(
      'INTERACTIVE_V2_TOOL_GRANT_INVALID',
      400,
    );
  }
}
