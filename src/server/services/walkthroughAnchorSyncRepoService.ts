/**
 * Resolves Apex's configured skill repo for walkthrough anchor Sync and
 * materializes a read-only checkout via the shared repo cache (same credentials
 * / connection model as project chat — not Cursor MCP).
 *
 * Remote Sync scans the configured branch tip (committed truth), not local WIP.
 * Non-production defaults to local disk so authors can discover uncommitted anchors.
 */

import type { SkillProvider } from '../../shared/types/projectSettings';
import {
  WalkthroughAnchorRegistryError,
  type WalkthroughAnchorSyncProvider,
} from '../../shared/types/walkthroughAnchorRegistry';
import { resolveSkillConfig } from './projectSettingsService';
import {
  checkoutDefaultBranch,
  getWorkspaceDir,
} from './repoCheckoutService';
import { APEX_WALKTHROUGH_PROJECT } from './walkthroughPageModuleScope';

/** Stable workspace id under data/dev-workspaces for Super Admin Sync checkouts. */
export const WALKTHROUGH_ANCHOR_SYNC_SESSION_ID = 'walkthrough-anchor-sync';

export interface ApexWalkthroughAnchorSyncCheckout {
  repositoryRoot: string;
  branch: string;
  repo: string;
  provider: Exclude<WalkthroughAnchorSyncProvider, 'local'>;
  project: string;
}

/**
 * GitHub skillRepo may be stored as `org/name` (local git origin style) or as
 * the bare repo name (Project Settings + GITHUB_ORG). resolveGitRemote always
 * prefixes GITHUB_ORG, so strip an embedded owner when present.
 */
export function normalizeSkillRepoForCheckout(
  provider: SkillProvider,
  skillRepo: string
): string {
  const trimmed = skillRepo.trim().replace(/\.git$/i, '');
  if (provider !== 'github') return trimmed;
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0) return trimmed;
  return trimmed.slice(slash + 1);
}

/**
 * Resolve Sync scan provider.
 * - Explicit command provider wins.
 * - Production without explicit provider → Apex skillProvider (github|ado).
 * - Otherwise → local (dev / test can scan cwd including WIP).
 */
export async function resolveWalkthroughAnchorSyncProvider(
  explicit?: WalkthroughAnchorSyncProvider | null
): Promise<WalkthroughAnchorSyncProvider> {
  if (
    explicit === 'local' ||
    explicit === 'github' ||
    explicit === 'ado'
  ) {
    return explicit;
  }

  if (process.env.NODE_ENV !== 'production') {
    return 'local';
  }

  const skillConfig = await resolveSkillConfig({
    project: APEX_WALKTHROUGH_PROJECT,
  });
  if (!skillConfig?.skillRepo?.trim()) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'The Apex project has no connected repository configured for walkthrough anchor sync.'
    );
  }

  const provider = skillConfig.skillProvider ?? 'ado';
  if (provider !== 'github' && provider !== 'ado') {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      `Unsupported Apex skillProvider for walkthrough anchor sync: ${String(provider)}`
    );
  }
  return provider;
}

/**
 * Materialize Apex's configured skill repo into a dedicated Sync workspace
 * using ensureRepoCache + worktree clone (same path as My Work / chat checkouts).
 */
export async function materializeApexWalkthroughAnchorSyncCheckout(
  provider: Exclude<WalkthroughAnchorSyncProvider, 'local'>
): Promise<ApexWalkthroughAnchorSyncCheckout> {
  const skillConfig = await resolveSkillConfig({
    project: APEX_WALKTHROUGH_PROJECT,
  });
  if (!skillConfig?.skillRepo?.trim()) {
    throw new WalkthroughAnchorRegistryError(
      'VALIDATION_ERROR',
      'The Apex project has no connected repository configured for walkthrough anchor sync.'
    );
  }

  const branch = skillConfig.skillBranch?.trim() || 'main';
  const repo = normalizeSkillRepoForCheckout(provider, skillConfig.skillRepo);

  await checkoutDefaultBranch({
    project: APEX_WALKTHROUGH_PROJECT,
    repo,
    branch,
    sessionId: WALKTHROUGH_ANCHOR_SYNC_SESSION_ID,
    provider,
  });

  return {
    repositoryRoot: getWorkspaceDir(WALKTHROUGH_ANCHOR_SYNC_SESSION_ID),
    branch,
    repo,
    provider,
    project: APEX_WALKTHROUGH_PROJECT,
  };
}
