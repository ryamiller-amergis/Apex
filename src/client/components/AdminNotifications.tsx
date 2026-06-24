import React from 'react';
import { NotificationPreferences } from './NotificationPreferences';
import { TeamsNotificationSettings } from './TeamsNotificationSettings';
import styles from './AdminNotifications.module.css';

export const AdminNotifications: React.FC = () => {
  return (
    <div className={styles['an-page']}>
      <section className={styles['an-section']}>
        <div className={styles['an-section-header']}>My Notification Preferences</div>
        <p className={styles['an-section-description']}>
          Control which notifications you receive and how they are delivered
        </p>
        <div className={styles['an-card']}>
          <NotificationPreferences />
        </div>
      </section>

      <section className={styles['an-section']}>
        <TeamsNotificationSettings />
      </section>
    </div>
  );
};
