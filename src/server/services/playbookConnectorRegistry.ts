/**
 * Outbound connectors a Playbook step may use.
 * Teams delivery stays one client, shared with ordinary notifications.
 */
import type { AppNotification } from '../../shared/types/notification';
import { sendTeamsNotification } from './teamsBotService';

export interface PlaybookConnector {
  id: string;
  displayName: string;
  secretRef?: string;
  inboundEvents: readonly string[];
  outboundOperations: readonly string[];
}

export const teamsConnector: PlaybookConnector = {
  id: 'teams',
  displayName: 'Microsoft Teams',
  secretRef: 'TEAMS_WEBHOOK_URL',
  inboundEvents: [],
  outboundOperations: ['send-message'],
};

export const playbookConnectors: readonly PlaybookConnector[] = [teamsConnector];

/**
 * Delivers a Teams message. An unset webhook or a delivery error does not reject:
 * the notification row is the step's result, and the push is a courtesy.
 */
export async function deliverPlaybookTeamsMessage(
  userId: string,
  notification: AppNotification,
): Promise<void> {
  try {
    await sendTeamsNotification(userId, notification);
  } catch {
    // The connector is best-effort. Callers already wrote the durable row.
  }
}
