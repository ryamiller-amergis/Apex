/**
 * FEAT-004 / TBI-007 — Shared Avatar: authenticated resolved image or
 * deterministic initials. Hosts never see Blob/Graph details.
 */
import React from 'react';
import { deriveInitials } from '../../shared/types/profile';
import { useAvatarObjectUrl, useResolvedAvatar } from '../hooks/useProfiles';
import styles from './SharedAvatar.module.css';

export type SharedAvatarSize = 'sm' | 'md' | 'lg';

export interface SharedAvatarProps {
  oid: string;
  displayName: string;
  /** Opaque cache version from AvatarSubject.version; null when never uploaded. */
  avatarVersion?: string | null;
  size?: SharedAvatarSize;
  /** When true, hides the avatar from the accessibility tree (trigger still named). */
  decorative?: boolean;
  className?: string;
}

export const SharedAvatar: React.FC<SharedAvatarProps> = ({
  oid,
  displayName,
  avatarVersion = null,
  size = 'md',
  decorative = false,
  className,
}) => {
  const trimmedOid = oid.trim();
  const query = useResolvedAvatar(trimmedOid, avatarVersion, trimmedOid.length > 0);
  const objectUrl = useAvatarObjectUrl(query.data);
  const initials = deriveInitials(displayName);
  const altText = `Avatar for ${displayName.trim() || 'unknown user'}`;

  const showImage =
    query.isSuccess &&
    query.data?.kind === 'image' &&
    typeof objectUrl === 'string' &&
    objectUrl.length > 0;

  const rootClass = [
    styles.root,
    styles[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={rootClass}
      data-testid={`shared-avatar-${trimmedOid}`}
      data-avatar-state={showImage ? 'image' : 'initials'}
      {...(decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img' as const, 'aria-label': altText })}
    >
      {showImage ? (
        <img
          src={objectUrl}
          alt={decorative ? '' : altText}
          className={styles.image}
          data-testid={`shared-avatar-image-${trimmedOid}`}
          draggable={false}
        />
      ) : (
        <span
          className={styles.initials}
          data-testid={`shared-avatar-initials-${trimmedOid}`}
        >
          {initials}
        </span>
      )}
    </span>
  );
};

export default SharedAvatar;
