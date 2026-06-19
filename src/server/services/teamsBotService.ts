import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference,
} from 'botbuilder';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { teamsConversationReferences } from '../db/schema';
import { getAppSetting } from './appSettingsService';
import type { AppNotification, NotificationType } from '../../shared/types/notification';

function createBotAdapter(): CloudAdapter {
  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: process.env.TEAMS_BOT_APP_ID ?? '',
    MicrosoftAppPassword: process.env.TEAMS_BOT_APP_PASSWORD ?? '',
    MicrosoftAppType: 'SingleTenant',
    MicrosoftAppTenantId: process.env.AZURE_TENANT_ID ?? '',
  });

  const botAuth = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);
  return new CloudAdapter(botAuth);
}

const adapter = createBotAdapter();

export async function handleIncoming(req: Request, res: Response): Promise<void> {
  try {
  await adapter.process(req, res, async (context: TurnContext) => {
    const activity = context.activity;

    const userOid = activity.from?.aadObjectId;

    if (activity.type === 'installationUpdate') {
      if (!userOid) return;

      if (activity.action === 'add') {
        const ref = TurnContext.getConversationReference(activity) as ConversationReference;
        await db
          .insert(teamsConversationReferences)
          .values({
            userOid,
            conversationReference: ref,
          })
          .onConflictDoUpdate({
            target: teamsConversationReferences.userOid,
            set: { conversationReference: ref },
          });
      } else if (activity.action === 'remove') {
        await db
          .delete(teamsConversationReferences)
          .where(eq(teamsConversationReferences.userOid, userOid));
      }
    } else if (activity.type === 'message') {
      console.log('[teams-bot] Message activity from:', { aadObjectId: activity.from?.aadObjectId, fromId: activity.from?.id, fromName: activity.from?.name });
      if (!userOid) {
        console.log('[teams-bot] No aadObjectId found — cannot store conversation reference');
        return;
      }
      const ref = TurnContext.getConversationReference(activity) as ConversationReference;
      await db
        .insert(teamsConversationReferences)
        .values({
          userOid,
          conversationReference: ref,
        })
        .onConflictDoUpdate({
          target: teamsConversationReferences.userOid,
          set: { conversationReference: ref },
        });
    }
  });
  } catch (err) {
    console.error('[teamsBotService] Error handling incoming activity:', err);
    if (!res.headersSent) {
      res.status(200).end();
    }
  }
}

export async function sendTeamsNotification(
  userOid: string,
  notification: AppNotification,
): Promise<void> {
  try {
    const row = await db.query.teamsConversationReferences.findFirst({
      where: eq(teamsConversationReferences.userOid, userOid),
    });

    if (!row) return;

    const enabledTypesSetting = await getAppSetting('teams_notification_enabled_types');
    if (enabledTypesSetting !== null) {
      let enabledTypes: NotificationType[];
      try {
        enabledTypes = JSON.parse(enabledTypesSetting) as NotificationType[];
      } catch {
        enabledTypes = ['system', 'ai', 'user-action', 'background'];
      }
      if (!enabledTypes.includes(notification.type)) return;
    }

    const ref = row.conversationReference as ConversationReference;

    const card = buildAdaptiveCard(notification);

    await adapter.continueConversationAsync(
      process.env.TEAMS_BOT_APP_ID ?? '',
      ref,
      async (context: TurnContext) => {
        await context.sendActivity({
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: card,
            },
          ],
        });
      },
    );
  } catch (err) {
    console.error('[teamsBotService] Failed to send Teams notification:', err);
  }
}

function buildAdaptiveCard(notification: AppNotification): object {
  const body: object[] = [
    {
      type: 'TextBlock',
      text: notification.title,
      weight: 'Bolder',
      size: 'Medium',
    },
  ];

  if (notification.body) {
    body.push({
      type: 'TextBlock',
      text: notification.body,
      wrap: true,
    });
  }

  const actions: object[] = [];
  if (notification.link) {
    const baseUrl = process.env.AZURE_REDIRECT_URL?.replace('/auth/callback', '') || 'https://app-scrum-dev.azurewebsites.net';
    const fullUrl = notification.link.startsWith('http') ? notification.link : `${baseUrl}${notification.link}`;
    actions.push({
      type: 'Action.OpenUrl',
      title: 'View',
      url: fullUrl,
    });
  }

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    ...(actions.length > 0 ? { actions } : {}),
  };
}
