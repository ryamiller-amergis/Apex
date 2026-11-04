/**
 * Unified build notification sender for the five build events (FEAT-016, PBI-037, TBI-030 / S6).
 */
import { eq } from 'drizzle-orm';
import type { BuildSupportContact } from '../../shared/types/build';
import type {
  BuildNotificationKind,
  BuildNotifyInput,
} from '../../shared/types/buildRunControls';
import type { NotificationType } from '../../shared/types/notification';
import { db } from '../db/drizzle';
import { buildRuns } from '../db/schema';
import { appendBuildEvent } from './buildEventsService';
import { buildNotificationCopy } from './buildNotificationCopy';
import {
  createNotification,
  isNotificationEnabled,
} from './notificationService';
import { trackEvent } from './telemetry';

export interface BuildNotifierContext {
  id: string;
  featureTitle: string;
  requesterUserId: string;
  supportContacts: BuildSupportContact[];
}

export interface BuildNotifierDeps {
  loadBuildContext: (buildRunId: string) => Promise<BuildNotifierContext | null>;
  isNotificationEnabled: (
    userId: string,
    type: NotificationType,
  ) => Promise<boolean>;
  createNotification: (
    userId: string,
    payload: { type: NotificationType; title: string; body?: string; link?: string },
    options?: { dedupeKey?: string },
  ) => Promise<unknown>;
  appendEvent: (input: {
    buildRunId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  track: (
    name: string,
    props: Record<string, string>,
    measurements?: Record<string, number>,
  ) => void;
}

function dedupeKeyFor(input: BuildNotifyInput, recipientUserId: string): string {
  const kind: BuildNotificationKind = input.kind;
  switch (kind) {
    case 'build_started':
      return `build:${input.buildRunId}:started:${recipientUserId}`;
    case 'preview_ready':
      return `build:${input.buildRunId}:preview:${input.revisionNumber ?? 1}:${recipientUserId}`;
    case 'run_suspended':
      return `build:${input.buildRunId}:suspended:${input.suspendEventId ?? 'latest'}:${recipientUserId}`;
    case 'deployment_failed':
      return `build:${input.buildRunId}:deploy-failed:${input.pipelineRunId ?? 'latest'}:${recipientUserId}`;
    case 'pull_request_created':
      return `build:${input.buildRunId}:pr:${input.revisionNumber ?? 1}:${recipientUserId}`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

const defaultDeps: BuildNotifierDeps = {
  async loadBuildContext(buildRunId) {
    const [row] = await db
      .select()
      .from(buildRuns)
      .where(eq(buildRuns.id, buildRunId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      featureTitle: row.prompt.slice(0, 120),
      requesterUserId: row.requestedByUserId,
      supportContacts: row.supportContacts ?? [],
    };
  },
  isNotificationEnabled,
  createNotification,
  async appendEvent(input) {
    await appendBuildEvent(input);
  },
  track: trackEvent,
};

export function createBuildNotifier(deps: BuildNotifierDeps = defaultDeps) {
  return {
    async notifyBuildEvent(input: BuildNotifyInput): Promise<void> {
      try {
        const ctx = await deps.loadBuildContext(input.buildRunId);
        if (!ctx) return;

        const copy = buildNotificationCopy(input.kind, {
          buildRunId: ctx.id,
          featureTitle: ctx.featureTitle,
          revisionNumber: input.revisionNumber,
          reason: input.reason,
          failedStage: input.failedStage,
          riskDecisionCount: input.riskDecisionCount,
        });

        const recipients =
          input.kind === 'deployment_failed'
            ? ctx.supportContacts.map((c) => c.userId).filter(Boolean)
            : [ctx.requesterUserId];

        let sentCount = 0;
        for (const userId of recipients) {
          const enabled = await deps.isNotificationEnabled(userId, 'build');
          if (!enabled) {
            await deps.appendEvent({
              buildRunId: ctx.id,
              eventType: 'notification_skipped',
              message: `Skipped ${input.kind} notification because user preferences muted build notifications.`,
              detail: { kind: input.kind, cause: 'preference' },
            });
            deps.track('build_notification_skipped', {
              buildRunId: ctx.id,
              kind: input.kind,
              cause: 'preference',
            });
            continue;
          }

          try {
            const dedupeKey = dedupeKeyFor(input, userId);
            await deps.createNotification(
              userId,
              {
                type: 'build',
                title: copy.title,
                body: copy.body,
                link: copy.link,
              },
              { dedupeKey },
            );
            sentCount += 1;
          } catch {
            await deps.appendEvent({
              buildRunId: ctx.id,
              eventType: 'notification_failed',
              severity: 'warn',
              message: `Could not create ${input.kind} notification.`,
              detail: { kind: input.kind, stage: 'insert' },
            });
            deps.track('build_notification_failed', {
              buildRunId: ctx.id,
              kind: input.kind,
              stage: 'insert',
            });
          }
        }

        if (sentCount > 0) {
          await deps.appendEvent({
            buildRunId: ctx.id,
            eventType: 'notification_sent',
            message: `Sent ${input.kind} notification.`,
            detail: { kind: input.kind, recipients: sentCount },
          });
          deps.track(
            'build_notification_sent',
            { buildRunId: ctx.id, kind: input.kind },
            { recipients: sentCount },
          );
        }
      } catch {
        // Never throw into caller after state change commits
      }
    },
  };
}

export const defaultBuildNotifier = createBuildNotifier();

export function notifyBuildEvent(input: BuildNotifyInput): Promise<void> {
  return defaultBuildNotifier.notifyBuildEvent(input);
}
