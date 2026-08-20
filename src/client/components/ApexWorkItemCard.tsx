import React, { useState, useRef, useCallback } from 'react';
import { useDrag } from 'react-dnd';
import type { ApexWorkItem, ApexWorkItemStatus } from '../../shared/types/apexWorkItem';
import { APEX_WORK_ITEM_STATUSES, STATUS_META } from '../../shared/types/apexWorkItem';
import styles from './ApexWorkItemCard.module.css';

function statusCssVars(status: ApexWorkItemStatus): React.CSSProperties {
  const accent = STATUS_META[status].tokenVar;
  return {
    ['--status-color' as string]: `var(${accent})`,
    ['--status-bg' as string]: `var(${accent}-bg)`,
    ['--status-border' as string]: `var(${accent}-border)`,
    ['--status-glow' as string]: `var(${accent}-glow)`,
  };
}

const DND_TYPE = 'APEX_CARD';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[parts.length - 1][0] ?? ''}`.toUpperCase();
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ApexWorkItemCardProps {
  item: ApexWorkItem;
  onOpen: (id: string) => void;
  onMove: (id: string, targetStatus: ApexWorkItemStatus) => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export const ApexWorkItemCard: React.FC<ApexWorkItemCardProps> = ({
  item,
  onOpen,
  onMove,
  selectMode = false,
  selected = false,
  onToggleSelect,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [{ isDragging }, dragRef] = useDrag({
    type: DND_TYPE,
    item: { id: item.id, status: item.status },
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const acTotal = item.acceptanceCriteria.length;
  const acDone = item.acceptanceCriteria.filter((c) => c.done).length;
  const acPct = acTotal > 0 ? (acDone / acTotal) * 100 : 0;

  const cssVars = statusCssVars(item.status);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(item.id);
      }
    },
    [item.id, onOpen],
  );

  const otherStatuses = APEX_WORK_ITEM_STATUSES.filter((s) => s !== item.status);

  return (
    <div
      ref={(el) => { dragRef(el); }}
      className={`${styles.card} ${isDragging ? styles.cardDragging : ''}`}
      style={cssVars}
      onClick={() => onOpen(item.id)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${item.title}, ${item.type}, ${STATUS_META[item.status].label}`}
      aria-pressed={selectMode ? selected : undefined}
     {...{ 'data-testid': 'work-item-card-card' }}>
      {selectMode && (
        <div
          style={{ marginBottom: 6 }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
         {...{ 'data-testid': 'work-item-card-div' }}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(item.id)}
            aria-label={`Select APX-${item.itemNumber}`}
            {...{ 'data-testid': `work-board-select-${item.id}` }}
          />
        </div>
      )}

      {/* Breadcrumb */}
      {(item.epicTitle || item.featureTitle) && (
        <div className={styles.breadcrumb}>
          {item.epicTitle && <span>{item.epicTitle}</span>}
          {item.epicTitle && item.featureTitle && <span className={styles.breadcrumbSep}>›</span>}
          {item.featureTitle && <span>{item.featureTitle}</span>}
        </div>
      )}

      {/* ID row */}
      <div className={styles.idRow}>
        <span className={styles.itemId}>APX-{item.itemNumber}</span>
        <span
          className={`${styles.typeChip} ${
            item.type === 'PBI' ? styles.typeChipPBI
              : item.type === 'TBI' ? styles.typeChipTBI
              : styles.typeChipBug
          }`}
        >
          {item.type}
        </span>
        {item.sourceType !== 'standalone' && (
          <span className={styles.sourceChip} title={item.sourceType === 'prd' ? 'From PRD' : 'From FR'}>
            {item.sourceType === 'prd' ? 'PRD' : 'FR'}
          </span>
        )}
        {item.release && (
          <span className={styles.sourceChip} title={`Target release: ${item.release.name}`}>
            {item.release.name}
          </span>
        )}
      </div>

      {/* Title */}
      <p className={styles.cardTitle}>{item.title}</p>

      {/* Outcome */}
      {item.outcome && <p className={styles.outcome}>{item.outcome}</p>}

      {/* Acceptance progress */}
      {acTotal > 0 && (
        <div className={styles.acProgress}>
          <div className={styles.acBar}>
            <div className={styles.acBarFill} style={{ width: `${acPct}%` }} />
          </div>
          <span className={styles.acText}>{acDone}/{acTotal}</span>
        </div>
      )}

      {/* Footer */}
      <div className={styles.footer}>
        {item.branch && (
          <span className={`${styles.metaItem} ${styles.metaItemBranch}`} title={item.branch}>
            <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 14 14">
              <path d="M4 1v5.5a2 2 0 002 2h4M10 7l2 1.5L10 10" />
            </svg>
          </span>
        )}
        {item.prUrl && (
          <span className={styles.metaItem} title="PR linked">
            <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 14 14">
              <circle cx="4" cy="3" r="1.5" />
              <circle cx="10" cy="3" r="1.5" />
              <circle cx="4" cy="11" r="1.5" />
              <path d="M4 4.5v5M10 4.5v2a2 2 0 01-2 2H7" />
            </svg>
          </span>
        )}

        <div className={styles.avatarStack}>
          {[item.owner, ...item.collaborators.slice(0, 2)].map((u, i) => (
            <span
              key={u.oid}
              className={styles.avatar}
              style={{ zIndex: 10 - i }}
              title={u.displayName}
            >
              {initials(u.displayName)}
            </span>
          ))}
        </div>

        <span className={styles.updatedAt}>{relativeTime(item.updatedAt)}</span>
      </div>

      {/* Keyboard Move-to menu */}
      <div
        className={styles.moveMenu}
        ref={menuRef}
        onClick={(e) => e.stopPropagation()}
       {...{ 'data-testid': 'work-item-card-move-menu' }}>
        <button
          className={styles.moveMenuBtn}
          aria-label="Move to another status"
          title="Move to"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((p) => !p); }}
         {...{ 'data-testid': 'work-item-card-move-to-another-status-btn' }}>
          ⋯
        </button>
        {menuOpen && (
          <div className={styles.moveMenuDropdown} role="menu">
            {otherStatuses.map((s) => (
              <button
                key={s}
                className={styles.moveMenuOption}
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onMove(item.id, s);
                }}
               {...{ 'data-testid': `work-item-card-move-menu-option-${s}` }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: `var(--status-${s})`,
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
