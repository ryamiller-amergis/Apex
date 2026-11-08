/**
 * Credentials for a temporary clone.
 *
 * The platform token is attached only for github.com and the host of ADO_ORG,
 * the same hosts the repository cache already authenticates. It is passed
 * through git's environment for one command and never written into the URL,
 * the workspace, or a creator-supplied host.
 */
export interface CloneCredential {
  env: Record<string, string>;
  /** Present only so a failure message can be redacted. Never log this. */
  secret: string | null;
}

function basicAuthEnv(username: string, secret: string): Record<string, string> {
  const encoded = Buffer.from(`${username}:${secret}`, 'utf-8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
  };
}

export function credentialsForCloneUrl(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): CloneCredential {
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const secret = env.GITHUB_TOKEN || env.GITHUB_PAT || env.GH_SKILL_TOKEN || '';
    if (!secret) return { env: {}, secret: null };
    return { env: basicAuthEnv('x-access-token', secret), secret };
  }
  const adoOrg = (env.ADO_ORG || '').trim();
  const pat = env.ADO_PAT || '';
  if (!adoOrg || !pat) return { env: {}, secret: null };
  try {
    if (host === new URL(adoOrg).hostname.toLowerCase()) {
      return { env: basicAuthEnv('pat', pat), secret: pat };
    }
  } catch {
    return { env: {}, secret: null };
  }
  return { env: {}, secret: null };
}

export function redactCloneFailure(text: string, secrets: Array<string | null | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[path]')
    .replace(/\/[\w./-]+/g, '[path]')
    .slice(0, 300);
}
