import { and, count, desc, eq } from 'drizzle-orm';
import type { Response } from 'express';
import { db } from '../db/drizzle';
import { notifications, notificationPreferences } from '../db/schema';
import type {
  AppNotification,
  NotificationPreference,
  NotificationType,
  NotificationSseEvent,
} from '../../shared/types/notification';
import { sendTeamsNotification } from './teamsBotService';

// ── SSE Connection Manager ────────────────────────────────────────────────────

const connections = new Map<string, Set<Response>>();

function subscribe(userId: string, res: Response): void {
  let userSet = connections.get(userId);
  if (!userSet) {
    userSet = new Set();
    connections.set(userId, userSet);
  }
  userSet.add(res);
}

function unsubscribe(userId: string, res: Response): void {
  const userSet = connections.get(userId);
  if (!userSet) return;
  userSet.delete(res);
  if (userSet.size === 0) connections.delete(userId);
}

function pushToUser(userId: string, event: NotificationSseEvent): void {
  const userSet = connections.get(userId);
  if (!userSet) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of userSet) {
    res.write(payload);
  }
}

// ── Row → shared type mapper ──────────────────────────────────────────────────

function toAppNotification(row: typeof notifications.$inferSelect): AppNotification {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read,
    createdAt: row.createdAt,
  };
}

function toNotificationPreference(row: typeof notificationPreferences.$inferSelect): NotificationPreference {
  return {
    id: row.id,
    userId: row.userId,
    notificationType: row.notificationType as NotificationType,
    enabled: row.enabled,
    toastEnabled: row.toastEnabled,
    updatedAt: row.updatedAt,
  };
}

// ── Notification CRUD ─────────────────────────────────────────────────────────

export async function createNotification(
  userId: string,
  payload: { type: NotificationType; title: string; body?: string; link?: string },
): Promise<AppNotification> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      type: payload.type,
      title: payload.title,
      body: payload.body ?? null,
      link: payload.link ?? null,
    })
    .returning();

  const notification = toAppNotification(row);

  const pref = await db.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.notificationType, payload.type),
    ),
  });

  const enabled = pref?.enabled ?? true;
  const toastEnabled = pref?.toastEnabled ?? true;

  if (enabled) {
    pushToUser(userId, {
      type: 'notification',
      notification,
      toast: toastEnabled,
    });
  }

  sendTeamsNotification(userId, notification).catch(() => {});

  return notification;
}

export async function getNotifications(
  userId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<AppNotification[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 20)
    .offset(opts.offset ?? 0);

  return rows.map(toAppNotification);
}

export async function markAsRead(userId: string, notificationId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
}

export async function markAllAsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ read: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}

export async function getUnreadCount(userId: string): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));

  return result?.value ?? 0;
}

// ── Preference Management ─────────────────────────────────────────────────────

export async function getPreferences(userId: string): Promise<NotificationPreference[]> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));

  return rows.map(toNotificationPreference);
}

export async function upsertPreference(
  userId: string,
  notificationType: NotificationType,
  updates: { enabled?: boolean; toastEnabled?: boolean },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (updates.enabled !== undefined) set.enabled = updates.enabled;
  if (updates.toastEnabled !== undefined) set.toastEnabled = updates.toastEnabled;

  await db
    .insert(notificationPreferences)
    .values({
      userId,
      notificationType,
      enabled: updates.enabled ?? true,
      toastEnabled: updates.toastEnabled ?? true,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.notificationType],
      set,
    });
}

export { subscribe, unsubscribe };
