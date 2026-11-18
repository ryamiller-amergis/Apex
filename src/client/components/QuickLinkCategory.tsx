import React, { useState } from 'react';
import styles from './QuickLinkCategory.module.css';

const TONES = [
  styles.tone0,
  styles.tone1,
  styles.tone2,
  styles.tone3,
  styles.tone4,
  styles.tone5,
  styles.tone6,
  styles.tone7,
];

export const OTHER_CATEGORY_LABEL = 'Other';

/** Same category name, same tone, on every screen and for every user. */
export function categoryToneIndex(category: string | null | undefined): number | null {
  const name = (category ?? '').trim().toLowerCase();
  if (!name) return null;
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % TONES.length;
}

/** Class that sets `--ql-tone` for a category; uncategorized links get the muted "Other" tone. */
export function categoryToneClass(category: string | null | undefined): string {
  const index = categoryToneIndex(category);
  return index === null ? styles.toneOther : TONES[index];
}

/** Six-dot drag handle, cropped to the dots so it fits in a row's left padding. */
export const GripIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="5.5 3 9 14" fill="currentColor" aria-hidden="true" className={className}>
    <circle cx="7.5" cy="5" r="1.4" />
    <circle cx="12.5" cy="5" r="1.4" />
    <circle cx="7.5" cy="10" r="1.4" />
    <circle cx="12.5" cy="10" r="1.4" />
    <circle cx="7.5" cy="15" r="1.4" />
    <circle cx="12.5" cy="15" r="1.4" />
  </svg>
);

interface CategoryToggleProps {
  category: string | null;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** Swaps the dot for a drag grip on hover and focus. */
  reorderable?: boolean;
  'data-testid': string;
}

/** A category heading inside the Quick Links menu that collapses or expands its links. */
export const CategoryToggle: React.FC<CategoryToggleProps> = ({
  category,
  count,
  expanded,
  onToggle,
  reorderable = false,
  'data-testid': testId,
}) => {
  const name = category ?? OTHER_CATEGORY_LABEL;
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${styles.heading} ${styles.headingButton} ${reorderable ? styles.headingReorderable : ''} ${categoryToneClass(category)}`}
      aria-expanded={expanded}
      aria-label={`${name}, ${count} link${count === 1 ? '' : 's'}`}
      aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      title={`${expanded ? 'Collapse' : 'Expand'} ${name}${reorderable ? '. Drag, or press Alt+↑/↓, to reorder' : ''}`}
      onClick={onToggle}
      {...{ 'data-testid': testId }}
    >
      {reorderable ? (
        <span className={styles.dotSlot}>
          <span className={styles.dot} />
          <GripIcon className={styles.grip} />
        </span>
      ) : (
        <span className={styles.dot} />
      )}
      <span className={styles.headingName}>{name}</span>
      <span className={styles.headingCount}>{count}</span>
      <span className={`${styles.headingChevron} ${expanded ? styles.headingChevronOpen : ''}`} aria-hidden="true">
        ▸
      </span>
    </button>
  );
};

interface CategoryPillProps {
  category: string | null;
  'data-testid'?: string;
}

export const CategoryPill: React.FC<CategoryPillProps> = ({ category, 'data-testid': testId }) => (
  <span
    className={`${styles.pill} ${categoryToneClass(category)}`}
    title={category ?? OTHER_CATEGORY_LABEL}
    {...(testId ? { 'data-testid': testId } : {})}
  >
    <span className={styles.pillText}>{category ?? OTHER_CATEGORY_LABEL}</span>
  </span>
);

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface QuickLinkFaviconProps {
  url: string;
  label: string;
  category: string | null;
}

/**
 * Loads `/favicon.ico` from the link's own site (no third-party favicon service, so internal
 * hostnames are not sent anywhere else). Until it loads, or if it fails, shows a letter tile.
 */
export const QuickLinkFavicon: React.FC<QuickLinkFaviconProps> = ({ url, label, category }) => {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  const letter = (label.trim()[0] ?? '?').toUpperCase();

  return (
    <span
      className={`${styles.favicon} ${categoryToneClass(category)} ${state === 'loaded' ? styles.faviconLoaded : ''}`}
      aria-hidden="true"
    >
      <span className={styles.faviconLetter}>{letter}</span>
      {origin && state !== 'failed' && (
        <img
          className={styles.faviconImage}
          src={`${origin}/favicon.ico`}
          alt=""
          width={20}
          height={20}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
        />
      )}
    </span>
  );
};
