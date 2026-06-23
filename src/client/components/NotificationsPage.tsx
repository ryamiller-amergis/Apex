import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications, useMarkAsRead, useMarkAllAsRead } from '../hooks/useNotifications';
import { useNotificationContext } from '../contexts/NotificationContext';
import { getTypeIcon, getRelativeTime, groupByDate } from './NotificationCenter';
import type { AppNotification, NotificationType } from '../../shared/types/notification';
import styles from './NotificationsPage.module.css';

const PAGE_SIZE = 20;

export const NotificationsPage: React.FC = () => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const { data: notifications = [], isLoading } = useNotifications({ limit });
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const { decrementUnread, resetUnread } = useNotificationContext();
  const navigate = useNavigate();

  const hasMore = notifications.length >= limit;

  const handleItemClick = (item: AppNotification) => {
    if (!item.read) {
      markAsRead.mutate(item.id);
      decrementUnread();
    }
    if (item.link) {
      navigate(item.link);
    }
  };

  const handleMarkAllRead = () => {
    markAllAsRead.mutate();
    resetUnread();
  };

  const grouped = groupByDate(notifications);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Notifications</h1>
        <button
          className={styles['mark-all-btn']}
          onClick={handleMarkAllRead}
          disabled={notifications.length === 0}
        >
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M2 8.5L6 12.5 14 4.5" />
          </svg>
          Mark all as read
        </button>
      </div>

      <div className={styles.list}>
        {isLoading ? (
          <div className={styles.empty}>Loading notifications...</div>
        ) : notifications.length === 0 ? (
          <div className={styles.empty}>No notifications yet</div>
        ) : (
          <>
            {grouped.map((group) => (
              <div key={group.label}>
                <div className={styles['group-label']}>{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`${styles.item} ${!item.read ? styles['item-unread'] : ''}`}
                    onClick={() => handleItemClick(item)}
                  >
                    <span className={styles['item-icon']}>
                      {getTypeIcon(item.type as NotificationType)}
                    </span>
                    <div className={styles['item-content']}>
                      <div className={styles['item-title']}>{item.title}</div>
                      {item.body && <div className={styles['item-body']}>{item.body}</div>}
                      <div className={styles['item-time']}>{getRelativeTime(item.createdAt)}</div>
                    </div>
                    {!item.read && <span className={styles['item-dot']} />}
                  </button>
                ))}
              </div>
            ))}
            {hasMore && (
              <div className={styles['load-more-container']}>
                <button
                  className={styles['load-more-btn']}
                  onClick={() => setLimit((prev) => prev + PAGE_SIZE)}
                >
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
