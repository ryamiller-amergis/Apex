export type NotificationType = 'system' | 'ai' | 'user-action' | 'background';

/** Events that trigger AI completion notifications to section owners and reviewers. */
export type AiCompletionEvent =
  | 'prd_generated'
  | 'test_cases_generated'
  | 'prd_validation_complete'
  | 'prd_fix_complete'
  | 'design_doc_generated'
  | 'design_doc_validation_complete'
  | 'design_doc_fix_complete'
  | 'design_prototype_generated';

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

export interface TeamsNotificationConfig {
  enabledTypes: NotificationType[];
}
