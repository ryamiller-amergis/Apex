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
  pageLayout?: boolean;
  /** Drops the header bar chrome and title, leaving only `actions`. */
  bareHeader?: boolean;
  /**
   * Lifts the bare header out of the layout flow so it does not reserve a row.
   * Only safe when the content below it is centered with room to spare.
   */
  floatHeader?: boolean;
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
  pageLayout = false,
  bareHeader = false,
  floatHeader = false,
}) => (
  <aside
    className={`${styles.shell} ${className ?? ''}`.trim()}
    style={pageLayout ? undefined : { width }}
    aria-label={ariaLabel}
    {...{ 'data-testid': 'agent-slideout-shell' }}
  >
    <div
      className={styles['overlay-mode-marker']}
      aria-hidden="true"
      {...{ 'data-testid': 'agent-slideout-overlay-mode' }}
    />
    {!pageLayout && onResizeMouseDown && (
      <div
        className={styles['resize-handle']}
        onMouseDown={onResizeMouseDown}
        role="separator"
        aria-label="Resize panel"
        aria-orientation="vertical"
      />
    )}
    <header
      className={[
        styles.header,
        bareHeader ? styles['header-bare'] : '',
        bareHeader && floatHeader ? styles['header-float'] : '',
      ].filter(Boolean).join(' ')}
    >
      {!bareHeader && <h2 className={styles.title}>{title}</h2>}
      <div className={styles.actions}>
        {actions}
        {!pageLayout && (
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={closeAriaLabel ?? `Close ${title}`}
            {...{ 'data-testid': closeTestId }}
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>
    </header>
    {status}
    {before}
    <div className={styles.body}>{children}</div>
    {composer}
  </aside>
);

export default AgentPanelShell;
