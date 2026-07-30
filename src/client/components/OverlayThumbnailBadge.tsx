import React from 'react';
import styles from './OverlayThumbnailBadge.module.css';

interface OverlayThumbnailBadgeProps {
  pageId: string;
}

export const OverlayThumbnailBadge: React.FC<
  OverlayThumbnailBadgeProps
> = ({ pageId }) => (
  <span
    className={styles.badge}
    aria-label="Page has text overlays"
    data-testid="pdf-tools-overlay-badge"
    data-page-id={pageId}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 5h14" />
      <path d="M12 5v14" />
      <path d="M8 19h8" />
    </svg>
  </span>
);
