import {
  decryptMcpServerCredential,
  encryptMcpServerCredential,
  IntegrationCredentialError,
  type EncryptedMcpServerCredential,
} from './mcpServerCredentialCrypto';

const CONNECTION_ID = 'teams-webhook';
const MAX_URL_LENGTH = 2048;
const UNPARSEABLE_WEBHOOK_MASK = 'Webhook saved';
const ALLOWED_HOST_SUFFIXES = [
  '.logic.azure.com',
  '.powerplatform.com',
  '.powerautomate.com',
  '.environment.api.powerplatform.com',
] as const;

/** The stored envelope: the encrypted URL plus a mask that is safe to show. */
export interface EncryptedWebhookUrl extends EncryptedMcpServerCredential {
  masked: string;
}

function binding(project: string) {
  return { project: `incident-triage:${project}`, connectionId: CONNECTION_ID };
}

/** Accepts only an https URL on a Teams Workflows host, with no credentials or port. */
export function isTeamsWorkflowsWebhookUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The host only; the path and query carry the secret. */
export function maskWebhookUrl(url: string): string {
  try {
    return `${new URL(url).host}…`;
  } catch {
    return UNPARSEABLE_WEBHOOK_MASK;
  }
}

export function encryptWebhookUrl(project: string, url: string): EncryptedWebhookUrl {
  return { ...encryptMcpServerCredential(url, binding(project)), masked: maskWebhookUrl(url) };
}

export function decryptWebhookUrl(project: string, envelope: Record<string, unknown>): string {
  const { iv, ciphertext, authTag } = envelope;
  if (typeof iv !== 'string' || typeof ciphertext !== 'string' || typeof authTag !== 'string') {
    throw new IntegrationCredentialError('INTEGRATION_CREDENTIAL_INVALID');
  }
  return decryptMcpServerCredential({ algorithm: 'aes-256-gcm', iv, ciphertext, authTag }, binding(project));
}

export function readMaskedWebhook(envelope: Record<string, unknown> | null): string | null {
  return typeof envelope?.masked === 'string' ? envelope.masked : null;
}
