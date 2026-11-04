/**
 * Build deployment notifications seam (FEAT-013, TBI-025, PBI-026, PBI-028 / S6).
 *
 * Sends preview-ready notifications to the requester and deployment-failed
 * notifications to each frozen Build support contact with dedupe keys and
 * Teams delivery failure recording.
 */
import type { BuildSupportContact } from '../../shared/types/build';
import type { AppNotification, NotificationType } from '../../shared/types/notification';
import { appendBuildEvent } from './buildEventsService';
import { redactText } from './buildRedactionService';
import { createNotification } from './notificationService';
import type { TeamsDeliveryStatus } from './teamsBotService';

export interface BuildDeploymentNotifierDeps {
  createNotification: (
    userId: string,
    payload: { type: NotificationType; title: string; body?: string; link?: string },
    options?: {
      dedupeKey?: string;
      onTeamsResult?: (result: TeamsDeliveryStatus) => void | Promise<void>;
    },
  ) => Promise<AppNotification>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
    dedupeKey?: string;
  }) => Promise<void>;
}

const defaultDeps: BuildDeploymentNotifierDeps = {
  createNotification,
  async appendEvent(input) {
    await appendBuildEvent(input);
  },
};

export function createBuildDeploymentNotifier(
  deps: BuildDeploymentNotifierDeps = defaultDeps,
) {
  return {
    async notifyPreviewReady(input: {
      buildRunId: string;
      revisionId: string;
      revisionNumber: number;
      pipelineRunId: string;
      requesterUserId: string;
    }): Promise<void> {
      const link = `/builds/${encodeURIComponent(input.buildRunId)}/preview`;
      const dedupeKey = `build-preview-ready:${input.pipelineRunId}:${input.requesterUserId}`;

      await deps.createNotification(
        input.requesterUserId,
        {
          type: 'system',
          title: 'Your preview is ready.',
          body: `Revision ${input.revisionNumber} has been deployed to the preview environment.`,
          link,
        },
        {
          dedupeKey,
          onTeamsResult: async (teamsResult) => {
            if (teamsResult === 'failed') {
              await deps.appendEvent({
                buildRunId: input.buildRunId,
                buildRevisionId: input.revisionId,
                eventType: 'deployment_notification_failed',
                severity: 'warn',
                message: 'Could not deliver the Teams preview notification.',
                detail: {
                  recipientUserId: input.requesterUserId,
                  channel: 'teams',
                  pipelineRunId: input.pipelineRunId,
                },
                dedupeKey: `teams-fail:preview:${input.pipelineRunId}:${input.requesterUserId}`,
              });
            }
          },
        },
      );
    },

    async notifyDeploymentFailed(input: {
      buildRunId: string;
      revisionId: string;
      pipelineRunId: string;
      commit: string;
      failedStage: string | null;
      errorText: string | null;
      pipelineUrl: string | null;
      supportContacts: readonly BuildSupportContact[];
    }): Promise<void> {
      const stage = redactText(input.failedStage?.trim() || 'deploy').slice(0, 200);
      const redactedError = redactText(input.errorText?.trim() || 'Deployment failed').slice(0, 500);
      const shortCommit = input.commit.slice(0, 7);
      const pipelineLinkText = input.pipelineUrl
        ? `Pipeline: ${input.pipelineUrl}`
        : 'Pipeline link unavailable';
      const body = `Failed stage: ${stage}. Commit ${shortCommit}. Error: ${redactedError}. ${pipelineLinkText}`;
      const link = `/builds/${encodeURIComponent(input.buildRunId)}/preview`;

      for (const contact of input.supportContacts) {
        if (!contact.userId) continue;
        const dedupeKey = `build-deploy-failed:${input.pipelineRunId}:${contact.userId}`;
        try {
          await deps.createNotification(
            contact.userId,
            {
              type: 'system',
              title: 'Build preview deployment failed',
              body,
              link,
            },
            {
              dedupeKey,
              onTeamsResult: async (teamsResult) => {
                if (teamsResult === 'failed') {
                  await deps.appendEvent({
                    buildRunId: input.buildRunId,
                    buildRevisionId: input.revisionId,
                    eventType: 'deployment_notification_failed',
                    severity: 'warn',
                    message: `Could not deliver the Teams failure notification to ${contact.displayName}.`,
                    detail: {
                      recipientUserId: contact.userId,
                      channel: 'teams',
                      pipelineRunId: input.pipelineRunId,
                    },
                    dedupeKey: `teams-fail:deploy:${input.pipelineRunId}:${contact.userId}`,
                  });
                }
              },
            },
          );
        } catch {
          // Isolate per-contact errors so remaining contacts are still notified (PBI-028 AC-2)
        }
      }

      await deps.appendEvent({
        buildRunId: input.buildRunId,
        buildRevisionId: input.revisionId,
        eventType: 'deployment_notified',
        message: 'Notified build support contacts of deployment failure.',
        detail: {
          pipelineRunId: input.pipelineRunId,
          contactCount: input.supportContacts.length,
        },
        dedupeKey: `deployment_notified:${input.pipelineRunId}`,
      });
    },
  };
}

export const defaultBuildDeploymentNotifier = createBuildDeploymentNotifier();
