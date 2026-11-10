import { z } from 'zod';
import { problemDetailsSchema } from '../conventions/problem-details.ts';
import { defineRoute } from '../define-route.ts';
import { contractSchemas } from '../schema-registry.ts';

export const notificationCategoryValues = [
  'system',
  'workflow',
  'insight',
  'alert',
] as const;

export const notificationCategorySchema = z.enum(notificationCategoryValues);

export const notificationItemSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(600),
    category: notificationCategorySchema,
    read: z.boolean(),
    createdAt: z.string().min(1).max(64),
  })
  .register(contractSchemas, {
    id: 'NotificationItem',
    description: 'One in-app notification for the authenticated principal.',
  });

export const notificationsListSchema = z
  .strictObject({
    items: z.array(notificationItemSchema),
    unreadCount: z.number().int().min(0),
  })
  .register(contractSchemas, {
    id: 'NotificationsList',
    description: 'Notifications and unread badge count for the caller.',
  });

export const createNotificationBodySchema = z
  .strictObject({
    title: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(600),
    category: notificationCategorySchema.optional(),
  })
  .register(contractSchemas, {
    id: 'CreateNotificationBody',
    description: 'Creates a new notification for the authenticated principal.',
  });

export const markNotificationReadBodySchema = z
  .strictObject({
    notificationId: z.string().trim().min(1).max(64).optional(),
    markAll: z.boolean().optional(),
  })
  .register(contractSchemas, {
    id: 'MarkNotificationReadBody',
    description:
      'Marks one notification or all notifications as read for the caller.',
  });

export type NotificationCategory = z.infer<typeof notificationCategorySchema>;
export type NotificationItem = z.infer<typeof notificationItemSchema>;
export type NotificationsList = z.infer<typeof notificationsListSchema>;
export type CreateNotificationBody = z.infer<
  typeof createNotificationBodySchema
>;
export type MarkNotificationReadBody = z.infer<
  typeof markNotificationReadBodySchema
>;

const exampleNotificationItem: NotificationItem = {
  id: 'notif-ops-01',
  title: 'Morning fulfillment batch completed',
  message:
    'All 42 priority orders cleared quality review with zero exceptions.',
  category: 'workflow',
  read: false,
  createdAt: '09:00 UTC',
};

const exampleNotificationsList: NotificationsList = {
  items: [exampleNotificationItem],
  unreadCount: 1,
};

const serviceUnavailableResponse = {
  description: 'The database is unavailable. Nothing was changed.',
  body: problemDetailsSchema,
};

export const getNotifications = defineRoute({
  id: 'getNotifications',
  method: 'get',
  path: '/api/v1/notifications',
  auth: 'principal',
  summary: 'List notifications for the caller',
  description:
    'Returns the caller notifications ordered newest first along with the unread count.',
  responses: {
    200: {
      description: 'Notifications for the caller',
      body: notificationsListSchema,
      example: exampleNotificationsList,
    },
    503: serviceUnavailableResponse,
  },
});

export const createNotification = defineRoute({
  id: 'createNotification',
  method: 'post',
  path: '/api/v1/notifications',
  auth: 'principal',
  summary: 'Create or trigger a notification for the caller',
  description:
    'Creates an operational notification for the caller and returns the updated list and unread count.',
  request: {
    body: createNotificationBodySchema,
    bodyExample: {
      title: exampleNotificationItem.title,
      message: exampleNotificationItem.message,
      category: exampleNotificationItem.category,
    },
  },
  responses: {
    200: {
      description: 'Updated notifications list after creation',
      body: notificationsListSchema,
      example: exampleNotificationsList,
    },
    503: serviceUnavailableResponse,
  },
});

export const markNotificationsRead = defineRoute({
  id: 'markNotificationsRead',
  method: 'put',
  path: '/api/v1/notifications',
  auth: 'principal',
  summary: 'Mark one or all notifications as read',
  description:
    'Marks a specific notification or all notifications as read for the authenticated principal.',
  request: {
    body: markNotificationReadBodySchema,
    bodyExample: {
      notificationId: exampleNotificationItem.id,
      markAll: false,
    },
  },
  responses: {
    200: {
      description: 'Updated notifications list',
      body: notificationsListSchema,
      example: {
        items: [{ ...exampleNotificationItem, read: true }],
        unreadCount: 0,
      },
    },
    503: serviceUnavailableResponse,
  },
});
