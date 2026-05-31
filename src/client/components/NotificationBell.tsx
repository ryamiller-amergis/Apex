import React, { useState, useRef, useEffect } from 'react';
import { useNotificationContext } from '../contexts/NotificationContext';
import { NotificationCenter } from './NotificationCenter';
import styles from './NotificationBell.module.css';

export const NotificationBell: React.FC = () => {
  const { unreadCount } = useNotificationContext();
  const [isOpen, setIsOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className={styles['bell-wrapper']} ref={bellRef}>
      <button
        className={`${styles['bell-button']} ${isOpen ? styles['bell-button-open'] : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
      >
        <svg viewBox="0 0 20 20" fill="none" className={styles['bell-icon']}>
          <path d="M10 2.5a4.5 4.5 0 00-4.5 4.5c0 2.5-.75 4.25-1.5 5.25-.38.5-.03 1.25.6 1.25h10.8c.63 0 .98-.75.6-1.25-.75-1-1.5-2.75-1.5-5.25A4.5 4.5 0 0010 2.5z" />
          <path d="M8 14a2 2 0 104 0" />
        </svg>
        {unreadCount > 0 && (
          <span className={styles['bell-badge']}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {isOpen && <NotificationCenter onClose={() => setIsOpen(false)} />}
    </div>
  );
};
