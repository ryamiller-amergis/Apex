import { isFeatureEnabled, isFlagEnabledForWholeProject } from '../featureFlagService';
import { resolveRepoReadServiceUrl } from './repoServiceReader';

/**
 * True when every run for the project goes to V2 hosts and App Service reads
 * repositories through the repo-read service, so an App Service checkout
 * would never be read.
 */
export async function readsThroughRepoReadService(input: {
  userId: string;
  project: string;
  caller: string;
}): Promise<boolean> {
  if (!resolveRepoReadServiceUrl()) return false;
  const [wholeV2, repoRead] = await Promise.all([
    isFlagEnabledForWholeProject('ai-runs-v2-transport', input.project).catch(() => false),
    isFeatureEnabled('repo-read-service', {
      userId: input.userId,
      project: input.project,
      caller: input.caller,
    }).catch(() => false),
  ]);
  return wholeV2 && repoRead;
}
