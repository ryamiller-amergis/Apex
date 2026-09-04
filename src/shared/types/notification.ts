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

/** Built-in completion alert sounds for AI generation toasts. */
export type GenerationSoundId = 'chime' | 'bell' | 'pop';

export const GENERATION_SOUND_OPTIONS: ReadonlyArray<{
  id: GenerationSoundId;
  label: string;
}> = [
  { id: 'chime', label: 'Chime' },
  { id: 'bell', label: 'Bell' },
  { id: 'pop', label: 'Pop' },
] as const;

export const DEFAULT_GENERATION_SOUND_ID: GenerationSoundId = 'chime';

/** Off by default so existing users are not surprised by new audio. */
export const DEFAULT_GENERATION_SOUND_ENABLED = false;

export interface GenerationSoundPreferences {
  generationSoundEnabled: boolean;
  generationSoundId: GenerationSoundId;
}

/** Titles emitted by aiCompletionNotifier for scoped generation-complete events. */
export const GENERATION_SOUND_NOTIFICATION_TITLES = [
  'PRD generation complete',
  'Design doc generated',
  'Design prototype ready',
] as const;

export function isGenerationSoundId(value: unknown): value is GenerationSoundId {
  return value === 'chime' || value === 'bell' || value === 'pop';
}

export function normalizeGenerationSoundPreferences(
  input?: Partial<{
    generationSoundEnabled: boolean;
    generationSoundId: string;
  }> | null,
): GenerationSoundPreferences {
  return {
    generationSoundEnabled:
      typeof input?.generationSoundEnabled === 'boolean'
        ? input.generationSoundEnabled
        : DEFAULT_GENERATION_SOUND_ENABLED,
    generationSoundId: isGenerationSoundId(input?.generationSoundId)
      ? input.generationSoundId
      : DEFAULT_GENERATION_SOUND_ID,
  };
}

/** True when an in-app AI toast should play a generation completion sound. */
export function shouldPlayGenerationSound(notification: {
  type: NotificationType;
  title: string;
}): boolean {
  if (notification.type !== 'ai') return false;
  return (GENERATION_SOUND_NOTIFICATION_TITLES as readonly string[]).includes(
    notification.title,
  );
}
