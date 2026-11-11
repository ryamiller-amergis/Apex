import type { BuildRunStatus } from '../../shared/types/build';
import { describeRuntimeFailure } from '../../shared/buildRuntimeFailure';

const STALE_MS = 2 * 60 * 1000;

export interface BuildProgressEvent {
  occurredAt: string;
  kind: string;
  message: string;
}

export interface BuildProgressHeadline {
  headline: string;
  stale: boolean;
  failed: boolean;
}

function ageMs(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, nowMs - parsed);
}

function agoLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function updatedSuffix(ms: number): string {
  if (ms < 45_000) return ' Updated just now.';
  return ` Updated ${agoLabel(ms)} ago.`;
}

/** The few states a requester sees in the header, whatever the internal stage. */
export function buildUserStatus(input: {
  status: BuildRunStatus | undefined;
  hasPullRequest: boolean;
}): string {
  if (input.hasPullRequest) return 'Ready to review';
  switch (input.status) {
    case undefined:
      return 'Loading…';
    case 'queued':
      return 'Queued';
    case 'intake':
      return 'Understanding your request';
    case 'planning':
    case 'building':
      return 'Building';
    case 'checking':
    case 'deploying':
    case 'accepted':
      return 'Finishing up';
    case 'preview_ready':
      return 'Ready to review';
    case 'cancelled':
      return 'Cancelled';
    case 'suspended':
    case 'needs_developer':
    case 'deployment_failed':
    case 'failed':
      return 'Needs your attention';
    default: {
      const exhaustive: never = input.status;
      return exhaustive;
    }
  }
}

/** Turns stored event text into a sentence a requester can read. */
export function userFacingBuildEvent(message: string): string {
  const runtime = describeRuntimeFailure(message);
  if (runtime) return runtime;
  if (/verification evidence for task .+ was refused/i.test(message)) {
    return 'The build finished without the required checks.';
  }
  if (/^Tasks .+ started in one agent\.?$/i.test(message)) {
    return 'Building and testing the feature.';
  }
  if (/^Task [\w-]+ started\.?$/i.test(message)) {
    return 'Building and testing the feature.';
  }
  if (/^Task [\w-]+ failed\.\s*/i.test(message)) {
    return message.replace(/^Task [\w-]+ failed\.\s*/i, '');
  }
  if (/^Task [\w-]+ will run again\.?$/i.test(message) || /^Apex is trying the build again\.?$/i.test(message)) {
    return 'Apex is going back to finish this. No action needed.';
  }
  if (/^The agent finished without the required test evidence\.?$/i.test(message)) {
    return 'The feature is built, but its test report left out some checks.';
  }
  if (/a task kept failing and no repair attempts are left/i.test(message)) {
    return 'This build needs your attention: Apex could not finish it on its own. Select Resume build to check it again, or contact a support contact for this project.';
  }
  if (/^Task [\w-]+ finished and is waiting to merge\.?$/i.test(message)) {
    return 'The feature passed its checks.';
  }
  if (/^Started fast revision \d+\.?$/i.test(message)) {
    return 'Applying your requested change to the live preview.';
  }
  if (/^Requested revision \d+\.?$/i.test(message)) {
    return 'Applying your requested change.';
  }
  return message.replace(/\bbuild-feature\b/g, 'the feature');
}

function latestEvent(events: readonly BuildProgressEvent[]): BuildProgressEvent | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return sorted[sorted.length - 1] ?? null;
}

export function buildProgressHeadline(input: {
  status: BuildRunStatus | undefined;
  events: readonly BuildProgressEvent[];
  hasPullRequest: boolean;
  nowMs: number;
}): BuildProgressHeadline {
  const status = input.status;
  const latest = latestEvent(input.events);
  const latestText = latest ? userFacingBuildEvent(latest.message) : '';
  const failed = status === 'failed' || status === 'deployment_failed' || status === 'needs_developer';

  if (input.hasPullRequest) {
    return { headline: 'Your feature is ready to review.', stale: false, failed: false };
  }
  if (failed) {
    return {
      headline: latestText || 'The build stopped before it finished.',
      stale: false,
      failed: true,
    };
  }
  if (status === 'cancelled') {
    return { headline: 'This build was cancelled.', stale: false, failed: false };
  }
  if (status === 'suspended') {
    return {
      headline: latestText || 'The build paused before it finished.',
      stale: false,
      failed: true,
    };
  }
  if (status === 'preview_ready') {
    return { headline: 'Your preview is ready to review.', stale: false, failed: false };
  }
  if (status === 'accepted') {
    return { headline: 'Opening the pull request.', stale: false, failed: false };
  }

  const liveWait =
    status === 'building' || status === 'checking' || status === 'deploying';
  const stale = Boolean(
    liveWait && latest && ageMs(latest.occurredAt, input.nowMs) >= STALE_MS
  );
  if (stale && latest) {
    return {
      headline: `No update for ${agoLabel(ageMs(latest.occurredAt, input.nowMs))}.`,
      stale: true,
      failed: false,
    };
  }

  if (status === 'planning') {
    return { headline: 'Preparing your build.', stale: false, failed: false };
  }
  if (status === 'checking') {
    return { headline: 'Running final checks.', stale: false, failed: false };
  }
  if (status === 'deploying') {
    return { headline: 'Starting the preview.', stale: false, failed: false };
  }
  if (status === 'building') {
    const line = latestText || 'Building and testing the feature.';
    const updated = latest ? updatedSuffix(ageMs(latest.occurredAt, input.nowMs)) : '';
    return { headline: `${line}${updated}`, stale: false, failed: false };
  }
  return { headline: latestText || 'Working on your request.', stale: false, failed: false };
}
