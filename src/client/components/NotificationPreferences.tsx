import React, { useState } from 'react';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '../hooks/useNotifications';
import {
  useGenerationSoundSettings,
  useUpdateGenerationSoundSettings,
} from '../hooks/useGenerationSoundSettings';
import type { GenerationSoundId, NotificationType } from '../../shared/types/notification';
import {
  DEFAULT_GENERATION_SOUND_ENABLED,
  DEFAULT_GENERATION_SOUND_ID,
  GENERATION_SOUND_OPTIONS,
} from '../../shared/types/notification';
import { playGenerationSound } from '../utils/generationSound';
import styles from './NotificationPreferences.module.css';

const NOTIFICATION_TYPES: { type: NotificationType; label: string; description: string; comingSoon?: boolean }[] = [
  { type: 'user-action', label: 'User Actions', description: 'Assignments, approvals, rejections, revisions' },
  {
    type: 'system',
    label: 'System Events',
    description: 'Walkthrough publications, deployments, builds, releases',
  },
  { type: 'ai', label: 'AI Completions', description: 'PRD generation, test cases, validation, design docs, prototypes' },
  { type: 'background', label: 'Background Jobs', description: 'Job status updates', comingSoon: true },
];

interface NotificationPreferencesProps {
  /**
   * When true (Profile page), surface load/update failures as contained
   * inline alerts without changing the existing mutation contract.
   */
  showContainedErrors?: boolean;
}

export const NotificationPreferences: React.FC<NotificationPreferencesProps> = ({
  showContainedErrors = false,
}) => {
  const [previewBlocked, setPreviewBlocked] = useState(false);

  const { data: preferences = [], isLoading, isError, refetch, error: loadError } =
    useNotificationPreferences();
  const updatePref = useUpdateNotificationPreference();
  const { data: soundPrefs } = useGenerationSoundSettings();
  const updateSound = useUpdateGenerationSoundSettings();

  const getPreference = (type: NotificationType) =>
    preferences.find((p) => p.notificationType === type);

  const soundEnabled = soundPrefs?.generationSoundEnabled ?? DEFAULT_GENERATION_SOUND_ENABLED;
  const soundId = soundPrefs?.generationSoundId ?? DEFAULT_GENERATION_SOUND_ID;

  const previewSound = async (nextSoundId: GenerationSoundId) => {
    setPreviewBlocked(!(await playGenerationSound(nextSoundId)));
  };

  if (isLoading) {
    return <div className={styles['prefs-loading']}>Loading preferences...</div>;
  }

  if (showContainedErrors && isError) {
    return (
      <div
        className={styles['prefs-error']}
        role="alert"
        {...{ 'data-testid': 'profile-section-error-notifications' }}
      >
        <div>{loadError?.message || 'Failed to load notification preferences.'}</div>
        <button
          type="button"
          className={styles['prefs-retry']}
          onClick={() => {
            void refetch();
          }}
          {...{ 'data-testid': 'notification-prefs-retry' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={styles['prefs-container']}>
      {showContainedErrors && updatePref.isError && (
        <div
          className={styles['prefs-error']}
          role="alert"
          {...{ 'data-testid': 'profile-section-error-notifications' }}
        >
          {updatePref.error?.message || 'Failed to update notification preference. Previous value retained.'}
        </div>
      )}
      {NOTIFICATION_TYPES.map(({ type, label, description, comingSoon }) => {
        const pref = getPreference(type);
        const enabled = pref?.enabled ?? true;
        const toastEnabled = pref?.toastEnabled ?? true;

        return (
          <div key={type} className={`${styles['prefs-row']} ${comingSoon ? styles['prefs-row-coming-soon'] : ''}`}>
            <div className={styles['prefs-info']}>
              <div className={styles['prefs-label']}>
                {label}
                {comingSoon && <span className={styles['prefs-badge']}>Coming soon</span>}
              </div>
              <div className={styles['prefs-description']}>{description}</div>
            </div>
            {!comingSoon && (
              <div className={styles['prefs-toggles']}>
                <label className={styles['prefs-toggle']}>
                  <span className={styles['prefs-toggle-label']}>Enabled</span>
                  <input
                    type="checkbox"
                    className={styles['prefs-checkbox']}
                    checked={enabled}
                    {...{ 'data-testid': `notification-pref-enabled-${type}` }}
                    onChange={(e) =>
                      updatePref.mutate({ notificationType: type, enabled: e.target.checked })
                    }
                  />
                  <span className={styles['prefs-switch']} />
                </label>
                <label className={`${styles['prefs-toggle']} ${!enabled ? styles['prefs-toggle-disabled'] : ''}`}>
                  <span className={styles['prefs-toggle-label']}>Toast</span>
                  <input
                    type="checkbox"
                    className={styles['prefs-checkbox']}
                    checked={toastEnabled}
                    disabled={!enabled}
                    {...{ 'data-testid': `notification-pref-toast-${type}` }}
                    onChange={(e) =>
                      updatePref.mutate({ notificationType: type, toastEnabled: e.target.checked })
                    }
                  />
                  <span className={styles['prefs-switch']} />
                </label>
              </div>
            )}
          </div>
        );
      })}

      <div className={styles['prefs-sound-section']}>
        <div className={styles['prefs-row']}>
          <div className={styles['prefs-info']}>
            <div className={styles['prefs-label']}>Completion Sound</div>
            <div className={styles['prefs-description']}>
              Play a short sound when a PRD, design doc, or prototype finishes generating
            </div>
          </div>
          <div className={styles['prefs-toggles']}>
            <label className={styles['prefs-toggle']}>
              <span className={styles['prefs-toggle-label']}>Enabled</span>
              <input
                type="checkbox"
                className={styles['prefs-checkbox']}
                checked={soundEnabled}
                {...{ 'data-testid': 'generation-sound-enabled' }}
                onChange={(e) => {
                  const nextEnabled = e.target.checked;
                  setPreviewBlocked(false);
                  updateSound.mutate({ generationSoundEnabled: nextEnabled });
                  // Switching it on is a real user gesture, which is the moment
                  // browsers allow audio — preview now so the choice is audible.
                  if (nextEnabled) void previewSound(soundId);
                }}
              />
              <span className={styles['prefs-switch']} />
            </label>
          </div>
        </div>

        <div
          className={`${styles['prefs-row']} ${!soundEnabled ? styles['prefs-row-muted'] : ''}`}
        >
          <div className={styles['prefs-info']}>
            <label className={styles['prefs-label']} htmlFor="generation-sound-select">
              Sound
            </label>
            <div className={styles['prefs-description']}>Pick the sound that plays</div>
          </div>
          <div className={styles['prefs-sound-controls']}>
            <select
              id="generation-sound-select"
              className={styles['prefs-select']}
              value={soundId}
              disabled={!soundEnabled}
              {...{ 'data-testid': 'generation-sound-select' }}
              onChange={(e) => {
                const nextSoundId = e.target.value as GenerationSoundId;
                setPreviewBlocked(false);
                updateSound.mutate({ generationSoundId: nextSoundId });
                void previewSound(nextSoundId);
              }}
            >
              {GENERATION_SOUND_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={styles['prefs-preview']}
              disabled={!soundEnabled}
              {...{ 'data-testid': 'generation-sound-preview' }}
              onClick={() => {
                setPreviewBlocked(false);
                void previewSound(soundId);
              }}
            >
              Preview
            </button>
          </div>
        </div>

        {previewBlocked && (
          <div
            className={styles['prefs-hint']}
            role="status"
            {...{ 'data-testid': 'generation-sound-blocked' }}
          >
            Your browser blocked audio. Click anywhere on the page, then press Preview again.
          </div>
        )}

        {updateSound.isError && (
          <div className={styles['prefs-hint']} role="alert">
            {updateSound.error?.message || 'Failed to save the sound preference.'}
          </div>
        )}
      </div>
    </div>
  );
};
