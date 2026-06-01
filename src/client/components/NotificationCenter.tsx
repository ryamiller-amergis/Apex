import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications, useMarkAsRead, useMarkAllAsRead } from '../hooks/useNotifications';
import { useNotificationContext } from '../contexts/NotificationContext';
import { NotificationPreferences } from './NotificationPreferences';
import type { AppNotification, NotificationType } from '../../shared/types/notification';
import styles from './NotificationCenter.module.css';

interface NotificationCenterProps {
  onClose: () => void;
}

export function getTypeIcon(type: NotificationType): React.ReactNode {
  switch (type) {
    case 'system':
      return (
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z" />
          <path d="M8 5v3M8 10h.007" />
        </svg>
      );
    case 'ai':
      return (
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M8 1.5l1.2 3.3 3.3 1.2-3.3 1.2L8 10.5l-1.2-3.3-3.3-1.2 3.3-1.2L8 1.5z" />
          <path d="M12 10l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z" />
        </svg>
      );
    case 'user-action':
      return (
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M8 8a3 3 0 100-6 3 3 0 000 6z" />
          <path d="M2.5 14a5.5 5.5 0 0111 0" />
        </svg>
      );
    case 'background':
      return (
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M3 8.5L6 11.5 13 4.5" />
        </svg>
      );
  }
}

export function getRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 172800) return 'yesterday';
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function groupByDate(items: AppNotification[]): { label: string; items: AppNotification[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: Record<string, AppNotification[]> = {};
  for (const item of items) {
    const d = new Date(item.createdAt);
    d.setHours(0, 0, 0, 0);
    const label = d >= today ? 'Today' : d >= yesterday ? 'Yesterday' : 'Earlier';
    (groups[label] ??= []).push(item);
  }

  const order = ['Today', 'Yesterday', 'Earlier'];
  return order.filter((l) => groups[l]).map((label) => ({ label, items: groups[label] }));
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({ onClose }) => {
  const { data: notifications = [], isLoading } = useNotifications({ limit: 10 });
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const { decrementUnread, resetUnread } = useNotificationContext();
  const navigate = useNavigate();
  const [showPreferences, setShowPreferences] = useState(false);

  const handleItemClick = (item: AppNotification) => {
    if (!item.read) {
      markAsRead.mutate(item.id);
      decrementUnread();
    }
    if (item.link) {
      navigate(item.link);
      onClose();
    }
  };

  if (showPreferences) {
    return (
      <div className={styles['center-dropdown']}>
        <div className={styles['center-header']}>
          <button
            className={styles['center-back-btn']}
            onClick={() => setShowPreferences(false)}
            aria-label="Back to notifications"
          >
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <h3 className={styles['center-title']}>Notification Settings</h3>
        </div>
        <NotificationPreferences />
      </div>
    );
  }

  const grouped = groupByDate(notifications);

  return (
    <div className={styles['center-dropdown']}>
      <div className={styles['center-header']}>
        <h3 className={styles['center-title']}>Notifications</h3>
        <div className={styles['center-actions']}>
          <button
            className={styles['center-action-btn']}
            onClick={() => { markAllAsRead.mutate(); resetUnread(); }}
            title="Mark all as read"
            aria-label="Mark all as read"
          >
            <svg viewBox="0 0 16 16" fill="none">
              <path d="M2 8.5L6 12.5 14 4.5" />
            </svg>
          </button>
          <button
            className={styles['center-action-btn']}
            onClick={() => setShowPreferences(true)}
            title="Notification settings"
            aria-label="Notification settings"
          >
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3L3.3 12.7" />
            </svg>
          </button>
        </div>
      </div>

      <div className={styles['center-body']}>
        {isLoading ? (
          <div className={styles['center-empty']}>Loading...</div>
        ) : notifications.length === 0 ? (
          <div className={styles['center-empty']}>No notifications yet</div>
        ) : (
          grouped.map((group) => (
            <div key={group.label}>
              <div className={styles['center-group-label']}>{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={`${styles['center-item']} ${!item.read ? styles['center-item-unread'] : ''}`}
                  onClick={() => handleItemClick(item)}
                >
                  <span className={styles['center-item-icon']}>{getTypeIcon(item.type as NotificationType)}</span>
                  <div className={styles['center-item-content']}>
                    <div className={styles['center-item-title']}>{item.title}</div>
                    {item.body && <div className={styles['center-item-body']}>{item.body}</div>}
                    <div className={styles['center-item-time']}>{getRelativeTime(item.createdAt)}</div>
                  </div>
                  {!item.read && <span className={styles['center-item-dot']} />}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      <div className={styles['center-footer']}>
        <button
          className={styles['center-footer-link']}
          onClick={() => { navigate('/notifications'); onClose(); }}
        >
          View all notifications
        </button>
      </div>
    </div>
  );
};
