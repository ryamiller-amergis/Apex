import React from 'react';
import type { DiagramEffectiveAccess, DiagramSummary } from '../../shared/types/diagram';
import styles from './DiagramCard.module.css';

interface DiagramCardProps {
  diagram: DiagramSummary;
  canDelete: boolean;
  canShare?: boolean;
  onOpen: (id: string) => void;
  onDelete?: (diagram: DiagramSummary) => void;
  onShare?: (diagram: DiagramSummary) => void;
  'data-testid'?: string;
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function accessBadgeLabel(access: DiagramEffectiveAccess): string {
  switch (access) {
    case 'owner':
      return 'Access: owner';
    case 'edit':
      return 'Access: can edit';
    case 'view':
      return 'Access: view only';
    default:
      return `Access: ${access}`;
  }
}

function accessBadgeText(access: DiagramEffectiveAccess): string {
  switch (access) {
    case 'owner':
      return 'Owner';
    case 'edit':
      return 'Can edit';
    case 'view':
      return 'View';
    default:
      return access;
  }
}

export const DiagramCard: React.FC<DiagramCardProps> = ({
  diagram,
  canDelete,
  canShare = false,
  onOpen,
  onDelete,
  onShare,
  'data-testid': testId,
}) => {
  const showDelete = canDelete && diagram.effectiveAccess === 'owner';
  const showShare = canShare && diagram.effectiveAccess === 'owner' && Boolean(onShare);
  const ownerLabel = diagram.ownerName ?? 'Unknown';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(diagram.id);
    }
  };

  return (
    <div
      className={styles.card}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(diagram.id)}
      onKeyDown={handleKeyDown}
      aria-label={`Open diagram ${diagram.title}`}
      {...{ 'data-testid': testId ?? `diagram-card-${diagram.id}` }}
    >
      <div className={styles.thumbWrap}>
        {diagram.thumbnail ? (
          <img
            className={styles.thumb}
            src={diagram.thumbnail}
            alt=""
            loading="lazy"
          />
        ) : (
          <div className={styles.thumbFallback} aria-hidden="true" />
        )}
        <span
          className={`${styles.badge} ${styles[`badge_${diagram.effectiveAccess}`] ?? ''}`}
          aria-label={accessBadgeLabel(diagram.effectiveAccess)}
          {...{
            'data-testid': diagram.effectiveAccess === 'owner'
              ? 'diagram-card-access-badge'
              : 'diagram-shared-badge',
          }}
        >
          {accessBadgeText(diagram.effectiveAccess)}
        </span>
      </div>

      <div className={styles.body}>
        <h3 className={styles.title}>{diagram.title}</h3>
        <div className={styles.meta}>
          <span className={styles.updated} title={new Date(diagram.updatedAt).toLocaleString()}>
            {formatRelativeTime(diagram.updatedAt)}
          </span>
          <span className={styles.owner} aria-label={`Owner: ${ownerLabel}`}>
            {ownerLabel}
          </span>
        </div>
      </div>

      {(showShare || showDelete) && (
        <div className={styles.actions}>
          {showShare && onShare && (
            <button
              type="button"
              className={styles.shareBtn}
              aria-label={`Share diagram ${diagram.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onShare(diagram);
              }}
              {...{ 'data-testid': 'diagram-share-button' }}
            >
              Share
            </button>
          )}
          {showDelete && onDelete && (
            <button
              type="button"
              className={styles.deleteBtn}
              aria-label={`Delete diagram ${diagram.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(diagram);
              }}
              {...{ 'data-testid': 'diagram-delete-button' }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default DiagramCard;
