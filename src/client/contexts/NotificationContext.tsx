import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AppNotification, NotificationSseEvent } from '../../shared/types/notification';

interface NotificationContextValue {
  unreadCount: number;
  toasts: AppNotification[];
  dismissToast: (id: string) => void;
  isConnected: boolean;
  decrementUnread: () => void;
  resetUnread: () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  unreadCount: 0,
  toasts: [],
  dismissToast: () => {},
  isConnected: false,
  decrementUnread: () => {},
  resetUnread: () => {},
});

export const useNotificationContext = () => useContext(NotificationContext);

const MAX_TOASTS = 3;
const TOAST_DURATION_MS = 5_000;

interface NotificationProviderProps {
  children: React.ReactNode;
}

export const NotificationProvider: React.FC<NotificationProviderProps> = ({ children }) => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const toastTimers = useRef<Map<string, number>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch('/api/notifications/unread-count', { credentials: 'include' })
      .then((r) => r.json())
      .then((data: { count: number }) => setUnreadCount(data.count))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/notifications/stream', { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => setIsConnected(true);
    es.onerror = () => setIsConnected(false);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as NotificationSseEvent;
        if (data.type === 'notification') {
          setUnreadCount((prev) => prev + 1);

          if (data.toast) {
            setToasts((prev) => {
              const next = [data.notification, ...prev];
              if (next.length > MAX_TOASTS) {
                const removed = next.pop()!;
                const timerId = toastTimers.current.get(removed.id);
                if (timerId != null) {
                  window.clearTimeout(timerId);
                  toastTimers.current.delete(removed.id);
                }
              }
              return next;
            });

            const timerId = window.setTimeout(() => {
              setToasts((prev) => prev.filter((t) => t.id !== data.notification.id));
              toastTimers.current.delete(data.notification.id);
            }, TOAST_DURATION_MS);
            toastTimers.current.set(data.notification.id, timerId);
          }
        }
      } catch {
        // ignore malformed SSE data
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);
      for (const timerId of toastTimers.current.values()) {
        window.clearTimeout(timerId);
      }
      toastTimers.current.clear();
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timerId = toastTimers.current.get(id);
    if (timerId != null) {
      window.clearTimeout(timerId);
      toastTimers.current.delete(id);
    }
  }, []);

  const decrementUnread = useCallback(() => {
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const resetUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  return (
    <NotificationContext.Provider value={{ unreadCount, toasts, dismissToast, isConnected, decrementUnread, resetUnread }}>
      {children}
    </NotificationContext.Provider>
  );
};
