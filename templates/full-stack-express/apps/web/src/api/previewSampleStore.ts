import type {
  AnalyzeInsightsBody,
  CreateNotificationBody,
  InsightsAnalysis,
  MarkNotificationReadBody,
  NotificationItem,
  NotificationsList,
  Profile,
  UpdateProfileBody,
} from '@project-scope/contracts';
import { sampleProfile } from '../testing/profileFixture';

export interface PreviewUserProfile extends Profile {
  role: string;
  avatarInitials: string;
}

const previewProfile: PreviewUserProfile = {
  ...sampleProfile,
  role: 'Operations Lead',
  avatarInitials: 'SE',
};

const SEEDED_NOTIFICATIONS: readonly NotificationItem[] = [
  {
    id: 'notif-ops-01',
    title: 'Morning fulfillment batch completed',
    message:
      'All 42 priority orders cleared quality review with zero exceptions.',
    category: 'workflow',
    read: false,
    createdAt: '2026-01-15T09:00:00Z',
  },
  {
    id: 'notif-insight-02',
    title: 'AI capacity forecast updated',
    message:
      'Midwest fulfillment hubs are projected to reach 94% utilization by Thursday.',
    category: 'insight',
    read: false,
    createdAt: '2026-01-15T08:30:00Z',
  },
  {
    id: 'notif-sys-03',
    title: 'Connector sync verified',
    message:
      'Logistics Telemetry Feed completed its scheduled 15-minute checkpoint.',
    category: 'system',
    read: true,
    createdAt: '2026-01-15T08:00:00Z',
  },
];

let previewNotifications: NotificationItem[] = SEEDED_NOTIFICATIONS.map(
  (item) => ({ ...item })
);
let customCounter = 10;

export function resetPreviewSampleStore(): void {
  previewProfile.displayName = sampleProfile.displayName;
  previewProfile.email = sampleProfile.email;
  previewProfile.status = sampleProfile.status;
  previewProfile.role = 'Operations Lead';
  previewProfile.avatarInitials = 'SE';
  previewNotifications = SEEDED_NOTIFICATIONS.map((item) => ({ ...item }));
  customCounter = 10;
}

/** In-memory profile for static previews (no API writes). */
export function readPreviewProfile(): Profile {
  return {
    displayName: previewProfile.displayName,
    email: previewProfile.email,
    status: previewProfile.status,
  };
}

export function readPreviewUserIdentity(): PreviewUserProfile {
  return { ...previewProfile };
}

export function writePreviewProfile(body: UpdateProfileBody): Profile {
  previewProfile.displayName = body.displayName;
  previewProfile.email = body.email ?? null;
  const parts = body.displayName.trim().split(/\s+/);
  previewProfile.avatarInitials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return readPreviewProfile();
}

export function readPreviewNotifications(): NotificationsList {
  return {
    items: previewNotifications.map((item) => ({ ...item })),
    unreadCount: previewNotifications.filter((item) => !item.read).length,
  };
}

export function createPreviewNotification(
  body: CreateNotificationBody
): NotificationsList {
  customCounter += 1;
  previewNotifications.unshift({
    id: `notif-custom-${customCounter}`,
    title: body.title.trim(),
    message: body.message.trim(),
    category: body.category ?? 'workflow',
    read: false,
    createdAt: '2026-01-15T10:00:00Z',
  });
  return readPreviewNotifications();
}

export function markPreviewNotificationsRead(
  body: MarkNotificationReadBody
): NotificationsList {
  previewNotifications = previewNotifications.map((item) =>
    body.markAll || item.id === body.notificationId
      ? { ...item, read: true }
      : item
  );
  return readPreviewNotifications();
}

export function runPreviewInsightsAnalysis(
  body: AnalyzeInsightsBody = {}
): InsightsAnalysis {
  const focusArea = body.focusArea ?? 'operations';
  const includeConnector = body.includeConnectorFeed ?? true;
  const connectorSource =
    body.connectorSource?.trim() || 'Logistics Telemetry Feed';

  const citations: InsightsAnalysis['citations'] = [
    {
      id: 'cit-db-orders',
      sourceKind: 'database',
      sourceLabel: 'Database · Fulfillment Ledger (3 active profile records)',
      excerpt:
        '42 priority batches completed with 98.4% on-time verification across primary hubs.',
    },
  ];
  if (includeConnector) {
    citations.push({
      id: 'cit-conn-carrier',
      sourceKind: 'connector',
      sourceLabel: `Connector · ${connectorSource}`,
      excerpt:
        'Regional hub ORD-2 reported a 35-minute dock queue spike between 14:00 and 16:00.',
    });
  }

  return {
    skillName: 'operational-briefing',
    modelId: 'composer-2.5',
    focusArea,
    headline:
      focusArea === 'retention'
        ? 'Enterprise SLA compliance holds at 98.4%, with two Midwest accounts needing proactive outreach.'
        : focusArea === 'capacity'
          ? 'Regional hubs have 18% buffer capacity overall, tightening to 6% on Thursday afternoon.'
          : 'Fulfillment throughput rose 14% while connector telemetry flagged two regional carrier delays.',
    findings: [
      {
        id: 'finding-carrier-delay',
        title: 'Rebalance Midwest carrier dispatch window',
        summary:
          'Database order cycle logs and carrier webhook telemetry show a 35-minute pickup lag on afternoon routes.',
        impact: 'high',
        recommendedAction:
          'Shift priority Midwest dispatches to the 13:30 cutoff and notify warehouse leads.',
        citationIds: citations.map((citation) => citation.id),
      },
    ],
    citations,
  };
}
