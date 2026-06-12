import React from 'react';
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '../hooks/useNotifications';
import type { NotificationType } from '../../shared/types/notification';
import styles from './NotificationPreferences.module.css';

const NOTIFICATION_TYPES: { type: NotificationType; label: string; description: string; comingSoon?: boolean }[] = [
  { type: 'user-action', label: 'User Actions', description: 'Assignments, approvals, rejections, revisions' },
  { type: 'system', label: 'System Events', description: 'Deployments, builds, releases', comingSoon: true },
  { type: 'ai', label: 'AI Completions', description: 'PRD generation, test cases, validation, design docs, prototypes' },
  { type: 'background', label: 'Background Jobs', description: 'Job status updates', comingSoon: true },
];

export const NotificationPreferences: React.FC = () => {
  const { data: preferences = [], isLoading } = useNotificationPreferences();
  const updatePref = useUpdateNotificationPreference();

  const getPreference = (type: NotificationType) =>
    preferences.find((p) => p.notificationType === type);

  if (isLoading) {
    return <div className={styles['prefs-loading']}>Loading preferences...</div>;
  }

  return (
    <div className={styles['prefs-container']}>
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
    </div>
  );
};
