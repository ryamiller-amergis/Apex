import React, { type ReactNode } from 'react';
import styles from './AgentPanelShell.module.css';

interface AgentPanelShellProps {
  title: string;
  ariaLabel: string;
  onClose: () => void;
  closeTestId: string;
  closeAriaLabel?: string;
  actions?: ReactNode;
  status?: ReactNode;
  before?: ReactNode;
  composer?: ReactNode;
  children: ReactNode;
  width?: number;
  onResizeMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
}

export const AgentPanelShell: React.FC<AgentPanelShellProps> = ({
  title,
  ariaLabel,
  onClose,
  closeTestId,
  closeAriaLabel,
  actions,
  status,
  before,
  composer,
  children,
  width = 420,
  onResizeMouseDown,
  className,
}) => (
  <aside
    className={`${styles.shell} ${className ?? ''}`.trim()}
    style={{ width }}
    aria-label={ariaLabel}
    {...{ 'data-testid': 'agent-slideout-shell' }}
  >
    <div
      className={styles['overlay-mode-marker']}
      aria-hidden="true"
      {...{ 'data-testid': 'agent-slideout-overlay-mode' }}
    />
    {onResizeMouseDown && (
      <div
        className={styles['resize-handle']}
        onMouseDown={onResizeMouseDown}
        role="separator"
        aria-label="Resize panel"
        aria-orientation="vertical"
      />
    )}
    <header className={styles.header}>
      <h2 className={styles.title}>{title}</h2>
      <div className={styles.actions}>
        {actions}
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={closeAriaLabel ?? `Close ${title}`}
          {...{ 'data-testid': closeTestId }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </header>
    {status}
    {before}
    <div className={styles.body}>{children}</div>
    {composer}
  </aside>
);

export default AgentPanelShell;
