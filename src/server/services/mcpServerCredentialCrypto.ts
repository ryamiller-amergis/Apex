import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const HKDF_SALT = 'apex-integration-connection-v1';
const HKDF_INFO = 'integration-credential';
const IV_BYTES = 12;

export class IntegrationCredentialError extends Error {
  constructor(readonly code: 'INTEGRATION_CREDENTIAL_KEY_UNAVAILABLE' | 'INTEGRATION_CREDENTIAL_INVALID') {
    super(code);
    this.name = 'IntegrationCredentialError';
  }
}

export interface EncryptedMcpServerCredential {
  algorithm: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface McpServerCredentialBinding {
  project: string;
  connectionId: string;
}

type SecretOptions = Readonly<{ secret?: string }>;

function resolveSecret(options?: SecretOptions): string {
  const secret = options && Object.prototype.hasOwnProperty.call(options, 'secret')
    ? options.secret
    : process.env.SESSION_SECRET;
  if (!secret?.trim()) {
    throw new IntegrationCredentialError('INTEGRATION_CREDENTIAL_KEY_UNAVAILABLE');
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

function bindingAad(binding: McpServerCredentialBinding): Buffer {
  return Buffer.from(JSON.stringify({
    project: binding.project,
    connectionId: binding.connectionId,
  }), 'utf8');
}

export function maskMcpServerCredential(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

export function encryptMcpServerCredential(
  plaintext: string,
  binding: McpServerCredentialBinding,
  options?: SecretOptions,
): EncryptedMcpServerCredential {
  const key = deriveKey(resolveSecret(options));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(bindingAad(binding));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptMcpServerCredential(
  encrypted: EncryptedMcpServerCredential,
  binding: McpServerCredentialBinding,
  options?: SecretOptions,
): string {
  const key = deriveKey(resolveSecret(options));
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(encrypted.iv, 'base64'),
    );
    decipher.setAAD(bindingAad(binding));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new IntegrationCredentialError('INTEGRATION_CREDENTIAL_INVALID');
  }
}
