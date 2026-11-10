import {
  createNotification,
  getNotifications,
  markNotificationsRead,
  zodIssuesToProblemErrors,
  type AnyRoute,
  type CreateNotificationBody,
  type MarkNotificationReadBody,
  type NotificationItem,
  type NotificationsList,
} from '@project-scope/contracts';
import express, { type Router } from 'express';
import { RequestValidationError } from '../../http/problems.ts';
import { getPrincipal, type Principal } from '../../identity/index.ts';
import { API_V1_PREFIX } from '../../routes/me.ts';
import { mountedAt } from '../../routes/inventory.ts';

const SEEDED_NOTIFICATIONS: readonly NotificationItem[] = Object.freeze([
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
]);

export interface NotificationsService {
  listForPrincipal(principal: Principal): Promise<NotificationsList>;
  createForPrincipal(
    principal: Principal,
    input: CreateNotificationBody
  ): Promise<NotificationsList>;
  markReadForPrincipal(
    principal: Principal,
    input: MarkNotificationReadBody
  ): Promise<NotificationsList>;
}

export function createNotificationsService(): NotificationsService {
  const bySubject = new Map<string, NotificationItem[]>();
  let sequence = 10;

  function ensureItems(subject: string): NotificationItem[] {
    let list = bySubject.get(subject);
    if (!list) {
      list = SEEDED_NOTIFICATIONS.map((item) => ({ ...item }));
      bySubject.set(subject, list);
    }
    return list;
  }

  function toResponse(items: readonly NotificationItem[]): NotificationsList {
    return {
      items: items.map((item) => ({ ...item })),
      unreadCount: items.filter((item) => !item.read).length,
    };
  }

  return {
    async listForPrincipal(principal) {
      return toResponse(ensureItems(principal.subject));
    },

    async createForPrincipal(principal, input) {
      const items = ensureItems(principal.subject);
      sequence += 1;
      const created: NotificationItem = {
        id: `notif-custom-${sequence}`,
        title: input.title.trim(),
        message: input.message.trim(),
        category: input.category ?? 'workflow',
        read: false,
        createdAt: '2026-01-15T10:00:00Z',
      };
      items.unshift(created);
      return toResponse(items);
    },

    async markReadForPrincipal(principal, input) {
      const items = ensureItems(principal.subject);
      for (const item of items) {
        if (input.markAll || item.id === input.notificationId) {
          item.read = true;
        }
      }
      return toResponse(items);
    },
  };
}

function pathUnder(prefix: string, route: AnyRoute): string {
  if (!route.path.startsWith(`${prefix}/`)) {
    throw new Error(`${route.id} is not under ${prefix}`);
  }
  return route.path.slice(prefix.length);
}

export function createNotificationsRouter(deps?: {
  notifications?: NotificationsService;
}): Router {
  const service = deps?.notifications ?? createNotificationsService();
  const router = mountedAt(express.Router(), API_V1_PREFIX);

  router.get(pathUnder(API_V1_PREFIX, getNotifications), async (_req, res) => {
    const result = await service.listForPrincipal(getPrincipal(res));
    res.json(getNotifications.responses[200].body.parse(result));
  });

  router.post(
    pathUnder(API_V1_PREFIX, createNotification),
    async (req, res) => {
      const parsed = createNotification.request.body.safeParse(req.body);
      if (!parsed.success) {
        throw new RequestValidationError(
          zodIssuesToProblemErrors(parsed.error.issues)
        );
      }
      const result = await service.createForPrincipal(
        getPrincipal(res),
        parsed.data
      );
      res.json(createNotification.responses[200].body.parse(result));
    }
  );

  router.put(
    pathUnder(API_V1_PREFIX, markNotificationsRead),
    async (req, res) => {
      const parsed = markNotificationsRead.request.body.safeParse(req.body);
      if (!parsed.success) {
        throw new RequestValidationError(
          zodIssuesToProblemErrors(parsed.error.issues)
        );
      }
      const result = await service.markReadForPrincipal(
        getPrincipal(res),
        parsed.data
      );
      res.json(markNotificationsRead.responses[200].body.parse(result));
    }
  );

  return router;
}
