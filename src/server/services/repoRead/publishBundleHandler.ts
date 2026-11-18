import { promises as dns } from 'node:dns';
import {
  assertCloneHostIsPublic,
  validateCloneUrl,
  type DnsLookup,
} from '../brainstorm/cloneUrlValidator';
import { publishTemporaryCloneBundle } from '../brainstorm/gitSourceClone';
import { parsePublishBundleHttpRequest, type PublishBundleHttpResponse } from './httpProtocol';

export interface PublishBundleHandlerDependencies {
  lookup: DnsLookup;
  publish: typeof publishTemporaryCloneBundle;
}

const defaultDependencies: PublishBundleHandlerDependencies = {
  lookup: async (hostname) =>
    (await dns.lookup(hostname, { all: true })).map((entry) => entry.address),
  publish: publishTemporaryCloneBundle,
};

/**
 * This service does the fetch, so it checks the URL and the host's addresses
 * itself rather than trusting the check App Service made when the source was
 * attached.
 */
export async function handlePublishBundleRequest(
  body: unknown,
  signal: AbortSignal,
  dependencies: PublishBundleHandlerDependencies = defaultDependencies,
): Promise<{ status: number; body: PublishBundleHttpResponse }> {
  const parsed = parsePublishBundleHttpRequest(body);
  if ('error' in parsed) return { status: 400, body: { ok: false, message: parsed.error } };
  const urlCheck = validateCloneUrl(parsed.url);
  if (!urlCheck.ok) return { status: 400, body: { ok: false, message: urlCheck.error } };
  const hostCheck = await assertCloneHostIsPublic(urlCheck.url, dependencies.lookup);
  if (!hostCheck.ok) return { status: 400, body: { ok: false, message: hostCheck.error } };

  try {
    const state = await dependencies.publish({
      url: urlCheck.url.toString(),
      sha: parsed.sha,
      identity: { provider: parsed.provider, project: parsed.project, repository: parsed.repository },
      signal,
    });
    return { status: 200, body: { ok: true, state } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[repo-read] publish-bundle failed (project=${parsed.project}): ${message.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300)}`,
    );
    return { status: 502, body: { ok: false, message: 'The repository could not be copied.' } };
  }
}
