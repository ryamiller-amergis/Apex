/**
 * FEAT-002 — Renders the resolved avatar: an authenticated-fetch image for
 * uploaded/graph sources, or an initials circle for the initials fallback.
 * The resolver endpoint requires credentials, so bytes are fetched via
 * `fetch` + `credentials: 'include'` and converted to a local object URL
 * rather than used directly as an <img> src.
 */
import React, { useEffect, useState } from 'react';
import { deriveInitials, type AvatarDescriptor } from '../../shared/types/profile';
import styles from './AvatarEditor.module.css';

interface AvatarPreviewProps {
  displayName: string;
  avatar: AvatarDescriptor;
}

export const AvatarPreview: React.FC<AvatarPreviewProps> = ({ displayName, avatar }) => {
  const avatarKey = `${avatar.source}:${avatar.url ?? ''}`;
  const [loadKey, setLoadKey] = useState(avatarKey);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  // Reset local load state when the avatar identity changes (render-time adjust).
  if (avatarKey !== loadKey) {
    setLoadKey(avatarKey);
    setObjectUrl(null);
    setImageFailed(false);
  }

  useEffect(() => {
    if (avatar.source === 'initials' || !avatar.url) {
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    fetch(avatar.url, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('Avatar image unavailable');
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => {
        if (!cancelled) setImageFailed(true);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [avatar.source, avatar.url]);

  const accessibleName = `${displayName}'s avatar`;

  if (avatar.source !== 'initials' && avatar.url && objectUrl && !imageFailed) {
    return (
      <img
        src={objectUrl}
        alt={accessibleName}
        className={styles.previewImage}
        data-testid="avatar-preview-image"
      />
    );
  }

  // Uploaded/graph bytes failed to load (e.g. offline) — fall back to
  // client-derived initials so the preview never renders blank.
  const initials = avatar.source === 'initials' ? avatar.initials : deriveInitials(displayName);

  return (
    <div
      className={styles.previewInitials}
      data-testid="avatar-preview-initials"
      role="img"
      aria-label={accessibleName}
    >
      {initials}
    </div>
  );
};

export default AvatarPreview;
