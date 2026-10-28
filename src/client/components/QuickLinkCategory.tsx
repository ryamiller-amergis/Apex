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

interface CategoryHeadingProps {
  category: string | null;
  'data-testid'?: string;
}

export const CategoryHeading: React.FC<CategoryHeadingProps> = ({ category, 'data-testid': testId }) => (
  <div
    className={`${styles.heading} ${categoryToneClass(category)}`}
    aria-hidden="true"
    {...(testId ? { 'data-testid': testId } : {})}
  >
    <span className={styles.dot} />
    {category ?? OTHER_CATEGORY_LABEL}
  </div>
);

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
