import React, { useState, useEffect } from 'react';
import { useTeamsNotificationConfig, useUpdateTeamsNotificationConfig } from '../hooks/useNotifications';
import { useAppShell } from '../hooks/useAppShell';
import type { NotificationType } from '../../shared/types/notification';
import styles from './TeamsNotificationSettings.module.css';

const NOTIFICATION_TYPES: { type: NotificationType; label: string }[] = [
  { type: 'ai', label: 'AI Completions' },
  { type: 'user-action', label: 'User Actions' },
  { type: 'system', label: 'System Events' },
  { type: 'background', label: 'Background Jobs' },
];

export const TeamsNotificationSettings: React.FC = () => {
  const { can } = useAppShell();
  const { data: config, isLoading } = useTeamsNotificationConfig();
  const update = useUpdateTeamsNotificationConfig();

  const [selected, setSelected] = useState<NotificationType[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (config) {
      setSelected(config.enabledTypes);
    }
  }, [config]);

  if (!can('admin:roles')) return null;

  if (isLoading) {
    return <div className={styles['tns-loading']}>Loading Teams notification settings...</div>;
  }

  const toggle = (type: NotificationType) => {
    setSaved(false);
    setSelected((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  };

  const handleSave = () => {
    update.mutate(
      { enabledTypes: selected },
      {
        onSuccess: () => setSaved(true),
      },
    );
  };

  return (
    <div className={styles['tns-container']}>
      <div className={styles['tns-header']}>Teams Notifications</div>
      <p className={styles['tns-description']}>
        Choose which notification types are sent to users via Microsoft Teams
      </p>
      <div className={styles['tns-types']}>
        {NOTIFICATION_TYPES.map(({ type, label }) => (
          <label key={type} className={styles['tns-row']}>
            <input
              type="checkbox"
              className={styles['tns-checkbox']}
              checked={selected.includes(type)}
              onChange={() => toggle(type)}
            />
            <span className={styles['tns-label']}>{label}</span>
          </label>
        ))}
      </div>
      <div className={styles['tns-footer']}>
        <button
          type="button"
          className={styles['tns-save-btn']}
          onClick={handleSave}
          disabled={update.isPending}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
        {saved && !update.isPending && (
          <span className={styles['tns-saved']}>Saved</span>
        )}
        {update.isError && (
          <span className={styles['tns-error']}>{update.error?.message ?? 'Save failed'}</span>
        )}
      </div>
    </div>
  );
};
