import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotificationContext } from '../contexts/NotificationContext';
import type { NotificationType } from '../../shared/types/notification';
import styles from './ToastContainer.module.css';

function getTypeLabel(type: NotificationType): string {
  switch (type) {
    case 'system': return 'System';
    case 'ai': return 'AI';
    case 'user-action': return 'Activity';
    case 'background': return 'Background';
  }
}

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useNotificationContext();
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className={styles['toast-container']}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles['toast']}
          role="alert"
          onClick={() => {
            if (toast.link) {
              navigate(toast.link);
              dismissToast(toast.id);
            }
          }}
          style={{ cursor: toast.link ? 'pointer' : 'default' }}
        >
          <div className={styles['toast-content']}>
            <span className={styles['toast-type']}>{getTypeLabel(toast.type as NotificationType)}</span>
            <span className={styles['toast-title']}>{toast.title}</span>
          </div>
          <button
            className={styles['toast-dismiss']}
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(toast.id);
            }}
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 14 14" fill="none">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
};
