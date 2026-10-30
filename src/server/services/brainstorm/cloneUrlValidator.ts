/**
 * Static checks for a temporary clone URL and revision.
 * Any public HTTPS host is allowed. Loopback, private, link-local and
 * metadata addresses are refused so a clone cannot reach the host network.
 * Platform credentials are never part of this check.
 */

export type CloneUrlFailure = {
  ok: false;
  code: 'INVALID_CLONE_URL' | 'INVALID_REVISION';
  field: 'cloneUrl' | 'revision';
  error: string;
};

export type CloneUrlSuccess = { ok: true; url: URL };

const MAX_URL_LENGTH = 2048;
const MAX_REVISION_LENGTH = 255;
const SHA_40 = /^[a-f0-9]{40}$/i;
const SHORT_OR_PARTIAL_SHA = /^[a-f0-9]{1,64}$/i;

export type DnsLookup = (hostname: string) => Promise<string[]>;

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':');
}

function ipv4ToParts(address: string): number[] | null {
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return null;
  return parts;
}

/** True for loopback, private, link-local, and the cloud metadata address. */
export function isBlockedCloneAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const v4 = ipv4ToParts(mapped ? mapped[1] : normalized);
  if (!v4) return false;
  const [a, b] = v4;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function validateRevision(revision: string): { ok: true } | CloneUrlFailure {
  const value = revision.trim();
  if (!value || value.length > MAX_REVISION_LENGTH) {
    return { ok: false, code: 'INVALID_REVISION', field: 'revision', error: 'Enter a branch name, a tag, or a full 40-character commit ID.' };
  }
  if (value.startsWith('-') || value.includes('..') || /[\s~^:?*[\\]/.test(value) || hasControlCharacter(value)) {
    return { ok: false, code: 'INVALID_REVISION', field: 'revision', error: 'That revision is not a branch, tag, or commit ID.' };
  }
  if (SHORT_OR_PARTIAL_SHA.test(value) && !SHA_40.test(value)) {
    return {
      ok: false,
      code: 'INVALID_REVISION',
      field: 'revision',
      error: 'Use the full 40-character commit ID, or a branch or tag name.',
    };
  }
  return { ok: true };
}

export function validateCloneUrl(raw: string): CloneUrlSuccess | CloneUrlFailure {
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH) {
    return { ok: false, code: 'INVALID_CLONE_URL', field: 'cloneUrl', error: 'Enter an HTTPS clone URL.' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: 'INVALID_CLONE_URL', field: 'cloneUrl', error: 'Enter an HTTPS clone URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'INVALID_CLONE_URL', field: 'cloneUrl', error: 'Enter an HTTPS clone URL.' };
  }
  if (url.password) {
    return { ok: false, code: 'INVALID_CLONE_URL', field: 'cloneUrl', error: 'Use HTTPS without a password in the URL.' };
  }
  // Azure DevOps copy links look like https://org@dev.azure.com/... The name is not a secret.
  if (url.username) {
    url.username = '';
    url.password = '';
  }
  if (url.port && url.port !== '443') {
    return { ok: false, code: 'INVALID_CLONE_URL', field: 'cloneUrl', error: 'The clone URL must use port 443.' };
  }
  if (!url.hostname || isIpLiteral(url.hostname) || url.hostname === 'localhost') {
    return { ok: false, code: 'INVALID_CLONE_URL', field: 'cloneUrl', error: 'The clone URL must name a public host.' };
  }
  return { ok: true, url };
}

export async function assertCloneHostIsPublic(
  url: URL,
  lookup: DnsLookup,
): Promise<{ ok: true } | CloneUrlFailure> {
  let addresses: string[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    return { ok: true };
  }
  if (addresses.length === 0) return { ok: true };
  if (addresses.some((address) => isBlockedCloneAddress(address))) {
    return {
      ok: false,
      code: 'INVALID_CLONE_URL',
      field: 'cloneUrl',
      error: 'That host is not reachable from the platform.',
    };
  }
  return { ok: true };
}
