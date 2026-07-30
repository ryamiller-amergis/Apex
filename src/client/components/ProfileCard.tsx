/**
 * FEAT-004 / TBI-007 — Read-only profile card projection (avatar, name, bio).
 * Presentational async boundary; ProfileCardTrigger owns dialog chrome.
 */
import React from 'react';
import { useProfileCard } from '../hooks/useProfiles';
import { SharedAvatar } from './SharedAvatar';
import styles from './ProfileCard.module.css';

export interface ProfileCardProps {
  oid: string;
  /** Optional display name used while the card query loads / for avatar alt. */
  displayNameHint?: string;
}

export const ProfileCard: React.FC<ProfileCardProps> = ({
  oid,
  displayNameHint = '',
}) => {
  const trimmedOid = oid.trim();
  const { data, isLoading, isError, isFetching } = useProfileCard(trimmedOid);

  if (isLoading || (isFetching && !data && !isError)) {
    return (
      <div
        className={styles.panel}
        data-testid={`profile-card-loading-${trimmedOid}`}
        aria-busy="true"
        role="status"
      >
        <div className={styles.skeletonAvatar} />
        <div className={styles.skeletonLines}>
          <div className={styles.skeletonLine} />
          <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
        </div>
        <span className={styles.srOnly}>Loading profile details</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div
        className={styles.panel}
        data-testid={`profile-card-unavailable-${trimmedOid}`}
        role="alert"
      >
        <p className={styles.unavailable}>Profile details are unavailable</p>
      </div>
    );
  }

  const displayName = data.displayName || displayNameHint || 'Unknown user';
  const bio = data.bio;

  return (
    <div
      className={styles.panel}
      data-testid={`profile-card-${trimmedOid}`}
    >
      <div className={styles.header}>
        <SharedAvatar
          oid={data.userOid}
          displayName={displayName}
          avatarVersion={data.avatar.version}
          size="lg"
        />
        <h2 className={styles.name} id={`profile-card-title-${trimmedOid}`}>
          {displayName}
        </h2>
      </div>
      {bio === null || bio.trim() === '' ? (
        <p className={styles.emptyBio} role="status">
          No bio provided
        </p>
      ) : (
        <p className={styles.bio}>{bio}</p>
      )}
    </div>
  );
};

export default ProfileCard;
