export type NotificationType = 'system' | 'ai' | 'user-action' | 'background';

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreference {
  id: string;
  userId: string;
  notificationType: NotificationType;
  enabled: boolean;
  toastEnabled: boolean;
  updatedAt: string;
}

export interface NotificationSseEvent {
  type: 'notification';
  notification: AppNotification;
  toast: boolean;
}

export interface UpsertNotificationPreferenceRequest {
  notificationType: NotificationType;
  enabled?: boolean;
  toastEnabled?: boolean;
}
