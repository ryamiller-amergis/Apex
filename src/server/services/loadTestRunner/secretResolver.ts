import { DefaultAzureCredential } from '@azure/identity';

export type SecretResolver = (
  refs: Record<string, string>,
) => Promise<Record<string, string>>;

type ParsedSecretRef = {
  vaultBaseUrl: string;
  secretName: string;
  version?: string;
};

/**
 * Parse Key Vault secret references:
 * - https://{vault}.vault.azure.net/secrets/{name}[/{version}]
 * - kv://{vault}/{name}
 * - {name} (uses LT_KEY_VAULT_URI)
 */
export function parseSecretRef(ref: string): ParsedSecretRef {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new Error('Key Vault secret reference is empty');
  }

  if (trimmed.startsWith('kv://')) {
    const rest = trimmed.slice('kv://'.length);
    const [vault, name] = rest.split('/');
    if (!vault || !name) {
      throw new Error(`Invalid kv:// secret ref: ${ref}`);
    }
    return {
      vaultBaseUrl: `https://${vault}.vault.azure.net`,
      secretName: name,
    };
  }

  if (/^https:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    // secrets/{name}/{version?}
    const secretsIdx = parts.indexOf('secrets');
    if (secretsIdx < 0 || !parts[secretsIdx + 1]) {
      throw new Error(`Invalid Key Vault secret URL: ${ref}`);
    }
    return {
      vaultBaseUrl: `${url.protocol}//${url.host}`,
      secretName: parts[secretsIdx + 1],
      version: parts[secretsIdx + 2],
    };
  }

  const vaultUri = process.env.LT_KEY_VAULT_URI?.replace(/\/+$/, '');
  if (!vaultUri) {
    throw new Error(
      `Key Vault secret name "${ref}" requires LT_KEY_VAULT_URI when not a full URL`,
    );
  }
  return { vaultBaseUrl: vaultUri, secretName: trimmed };
}

/**
 * Resolve secret refs via Key Vault REST + DefaultAzureCredential.
 * Avoids adding @azure/keyvault-secrets (package.json is protected).
 */
export function createKeyVaultSecretResolver(options?: {
  getToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): SecretResolver {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const getToken =
    options?.getToken ??
    (async () => {
      const credential = new DefaultAzureCredential();
      const token = await credential.getToken('https://vault.azure.net/.default');
      if (!token?.token) {
        throw new Error('Failed to acquire Key Vault access token');
      }
      return token.token;
    });

  return async (refs) => {
    const resolved: Record<string, string> = {};
    for (const [envName, ref] of Object.entries(refs)) {
      const parsed = parseSecretRef(ref);
      const token = await getToken();
      const versionPath = parsed.version ? `/${parsed.version}` : '';
      const url = `${parsed.vaultBaseUrl}/secrets/${encodeURIComponent(parsed.secretName)}${versionPath}?api-version=7.4`;
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Key Vault secret resolution failed for "${envName}" (${res.status}): ${text || res.statusText}`,
        );
      }
      const body = (await res.json()) as { value?: string };
      if (typeof body.value !== 'string') {
        throw new Error(
          `Key Vault secret resolution failed for "${envName}": empty value`,
        );
      }
      resolved[envName] = body.value;
    }
    return resolved;
  };
}
