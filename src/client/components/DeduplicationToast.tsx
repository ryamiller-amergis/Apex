import React, { useEffect, useState } from 'react';
import styles from './DeduplicationToast.module.css';

interface DeduplicationToastProps {
  visible: boolean;
  onDismiss: () => void;
}

export const DeduplicationToast: React.FC<DeduplicationToastProps> = ({
  visible,
  onDismiss,
}) => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      const timer = setTimeout(() => {
        setShow(false);
        onDismiss();
      }, 4000);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
    }
  }, [visible, onDismiss]);

  if (!show) return null;

  return (
    <div
      className={styles.toast}
      role="status"
      aria-live="polite"
      data-testid="pdf-dedup-toast"
    >
      <span className={styles.message}>Duplicate pages removed</span>
      <button
        className={styles.dismiss}
        onClick={() => {
          setShow(false);
          onDismiss();
        }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
};
