/**
 * Pure accept state derivation and copy helpers (FEAT-015, S1).
 */
import type {
  BuildAcceptState,
  BuildRunStatus,
  BuildTaskStatus,
} from '../../../shared/types/build';
import { formatSupportContacts } from '../../../shared/buildPlanCopy';

export function deriveAcceptState(
  run: { status: BuildRunStatus; pullRequestUrl: string | null },
  syncTask?: { status: BuildTaskStatus } | null
): BuildAcceptState {
  if (run.status === 'needs_developer') {
    return 'needs_developer';
  }
  if (run.pullRequestUrl) {
    return 'pull_request_open';
  }
  if (
    syncTask &&
    (syncTask.status === 'pending' ||
      syncTask.status === 'ready' ||
      syncTask.status === 'running')
  ) {
    return 'syncing';
  }
  return 'opening_pull_request';
}

export function describeAcceptState(
  state: BuildAcceptState,
  contactNames: readonly string[] = []
): string {
  const who = formatSupportContacts(contactNames);
  switch (state) {
    case 'deploying_preview':
      return 'Deploying your preview. Apex opens the pull request when it is ready.';
    case 'opening_pull_request':
      return 'Opening your pull request…';
    case 'syncing':
      return 'Your feature is being brought up to date with the latest code. This can take several minutes.';
    case 'pull_request_open':
      return 'Your pull request is open. Engineers will review it.';
    case 'needs_developer':
      return `We could not bring your feature up to date with the latest code on our own. ${who} have been told and will pick it up.`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
