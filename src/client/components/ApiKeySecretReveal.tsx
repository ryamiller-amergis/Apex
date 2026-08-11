import React, { useCallback, useRef, useState } from 'react';
import styles from './ApiKeySecretReveal.module.css';

export interface ApiKeySecretRevealProps {
  rawKey: string;
  /** Optional className for the outer panel. */
  className?: string;
}

export const ApiKeySecretReveal: React.FC<ApiKeySecretRevealProps> = ({
  rawKey,
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rawKey);
    } catch {
      // Fallback for environments without clipboard permission
      const textarea = document.createElement('textarea');
      textarea.value = rawKey;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, [rawKey]);

  return (
    <div
      className={`${styles.panel}${className ? ` ${className}` : ''}`}
      {...{ 'data-testid': 'api-key-secret-reveal' }}
    >
      <p className={styles.warning} role="status">
        Copy this key now — you will not be able to view it again.
      </p>
      <code
        className={styles.secret}
        {...{ 'data-testid': 'api-key-secret-value' }}
      >
        {rawKey}
      </code>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={() => {
            void handleCopy();
          }}
          aria-label="Copy API key"
          {...{ 'data-testid': 'api-key-copy' }}
        >
          Copy
        </button>
        <span
          className={styles.copied}
          aria-live="polite"
          {...{ 'data-testid': 'api-key-copied' }}
        >
          {copied ? 'Copied' : ''}
        </span>
      </div>
    </div>
  );
};

export default ApiKeySecretReveal;
