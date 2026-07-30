/**
 * FEAT-002 — Standalone Avatar management surface (PBI-003 upload/replace,
 * PBI-004 remove). Isolated component: composition into `/profile` and the
 * header/menu trigger is owned by later Feature waves (FEAT-003/004/005).
 */
import React, { useRef, useState } from 'react';
import {
  AVATAR_MAX_BYTES,
  type AvatarDescriptor,
  type NormalizedAvatarCrop,
} from '../../shared/types/profile';
import { avatarDescriptorFromSubject, useDeleteAvatar, useUploadAvatar } from '../hooks/useAvatar';
import { AvatarPreview } from './AvatarPreview';
import { AvatarCropDialog } from './AvatarCropDialog';
import { RemoveAvatarDialog } from './RemoveAvatarDialog';
import styles from './AvatarEditor.module.css';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ACCEPTED_ATTR = 'image/jpeg,image/png,image/webp';

interface AvatarEditorProps {
  userOid: string;
  displayName: string;
  /** Current resolved descriptor; if omitted, derive from avatarVersion. */
  avatar?: AvatarDescriptor | null;
  /** FEAT-001 version token from AvatarSubject.version. */
  avatarVersion?: string | null;
  /** Optional override for the upload/replace control data-testid (FEAT-003 Profile). */
  uploadControlTestId?: string;
  /** Optional override for the remove button data-testid (FEAT-003 Profile). */
  removeButtonTestId?: string;
  /** Optional override for the edit (re-crop) button data-testid. */
  editButtonTestId?: string;
}

type OperationStatus = { kind: 'success' | 'error'; text: string } | null;

const IconPencil: React.FC = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path
      d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

const IconUpload: React.FC = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path
      d="M8 11V3M5 5.5L8 2.5l3 3M3 13h10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconTrash: React.FC = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    <path
      d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const AvatarEditor: React.FC<AvatarEditorProps> = ({
  userOid,
  displayName,
  avatar = null,
  avatarVersion = null,
  uploadControlTestId = 'avatar-upload-control',
  removeButtonTestId = 'avatar-remove-open',
  editButtonTestId = 'avatar-edit-open',
}) => {
  const [descriptor, setDescriptor] = useState<AvatarDescriptor>(
    () => avatar ?? avatarDescriptorFromSubject({ userOid, version: avatarVersion ?? null }, displayName)
  );
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [status, setStatus] = useState<OperationStatus>(null);
  const [editPending, setEditPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useUploadAvatar();
  const deleteMutation = useDeleteAvatar();

  // Keep local preview in sync when the profile cache clears the upload version
  // after remove (or when a parent remounts with a new AvatarSubject).
  React.useEffect(() => {
    if (avatar) {
      setDescriptor(avatar);
      return;
    }
    setDescriptor(
      avatarDescriptorFromSubject({ userOid, version: avatarVersion ?? null }, displayName)
    );
  }, [avatar, avatarVersion, userOid, displayName]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    // Reset so re-selecting the same file still fires a change event.
    e.target.value = '';
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setStatus({ kind: 'error', text: 'File must be a JPEG, PNG, or WebP image.' });
      return;
    }
    if (file.size <= 0 || file.size > AVATAR_MAX_BYTES) {
      setStatus({ kind: 'error', text: 'File must be greater than 0 bytes and no more than 5 MB.' });
      return;
    }

    setStatus(null);
    setPendingFile(file);
  }

  function handleCropCancel() {
    setPendingFile(null);
  }

  function handleCropConfirm(file: File, crop: NormalizedAvatarCrop) {
    uploadMutation.mutate(
      { file, crop },
      {
        onSuccess: (data) => {
          setDescriptor(data.avatar);
          setPendingFile(null);
          setStatus({ kind: 'success', text: 'Avatar updated.' });
        },
        onError: (err) => {
          // PBI-003 AC-1: keep the crop dialog open and the prior preview intact.
          setStatus({
            kind: 'error',
            text: err.message || 'Failed to upload avatar. Your previous avatar is unchanged.',
          });
        },
      }
    );
  }

  async function handleEditCurrent() {
    if (descriptor.source !== 'uploaded' || !descriptor.url) return;
    setStatus(null);
    setEditPending(true);
    try {
      const res = await fetch(descriptor.url, { credentials: 'include' });
      if (!res.ok) {
        throw new Error('Avatar image unavailable');
      }
      const blob = await res.blob();
      const type = ACCEPTED_TYPES.includes(blob.type) ? blob.type : 'image/webp';
      const extension = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
      setPendingFile(new File([blob], `avatar.${extension}`, { type }));
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to open avatar for editing.',
      });
    } finally {
      setEditPending(false);
    }
  }

  function handleRemoveOpen() {
    setStatus(null);
    setRemoveDialogOpen(true);
  }

  function handleRemoveCancel() {
    setRemoveDialogOpen(false);
  }

  function handleRemoveConfirm() {
    deleteMutation.mutate(undefined, {
      onSuccess: (data) => {
        setDescriptor(data.avatar);
        setRemoveDialogOpen(false);
        setStatus({ kind: 'success', text: 'Avatar removed.' });
      },
      onError: (err) => {
        // PBI-004 AC-1: keep the confirmation dialog open with an honest error.
        setStatus({
          kind: 'error',
          text: err.message || 'Failed to remove avatar. Your avatar is unchanged.',
        });
      },
    });
  }

  // PBI-004 AC-2: Remove / Edit are available only when an uploaded avatar is active.
  const canEditUploaded = descriptor.source === 'uploaded' && Boolean(descriptor.url);
  const uploadLabel = canEditUploaded ? 'Change photo' : 'Upload avatar';

  return (
    <div className={styles.root} data-testid="avatar-editor">
      <div className={styles.previewShell}>
        <AvatarPreview displayName={displayName} avatar={descriptor} />
        {canEditUploaded && (
          <button
            type="button"
            className={styles.previewEditBadge}
            data-testid={editButtonTestId}
            onClick={() => {
              void handleEditCurrent();
            }}
            disabled={editPending || uploadMutation.isPending}
            aria-label="Edit current avatar"
            title="Edit current avatar"
          >
            <IconPencil />
          </button>
        )}
      </div>

      <div className={styles.actions}>
        <input
          ref={fileInputRef}
          id="avatar-file-input"
          data-testid="avatar-file-input"
          type="file"
          accept={ACCEPTED_ATTR}
          aria-describedby="avatar-editor-instructions"
          className={styles.fileInput}
          onChange={handleFileChange}
        />

        {canEditUploaded ? (
          <>
            <button
              type="button"
              className={styles.btnSecondary}
              data-testid={`${editButtonTestId}-text`}
              onClick={() => {
                void handleEditCurrent();
              }}
              disabled={editPending || uploadMutation.isPending}
            >
              <IconPencil />
              {editPending ? 'Opening…' : 'Edit'}
            </button>
            <label
              htmlFor="avatar-file-input"
              className={styles.btnSecondary}
              data-testid={uploadControlTestId}
            >
              <IconUpload />
              {uploadLabel}
            </label>
            <button
              type="button"
              data-testid={removeButtonTestId}
              className={styles.btnDanger}
              onClick={handleRemoveOpen}
            >
              <IconTrash />
              Remove
            </button>
          </>
        ) : (
          <label
            htmlFor="avatar-file-input"
            className={styles.btnPrimary}
            data-testid={uploadControlTestId}
          >
            <IconUpload />
            {uploadLabel}
          </label>
        )}
      </div>

      <p id="avatar-editor-instructions" className={styles.instructions}>
        JPEG, PNG, or WebP, up to 5 MB.
      </p>

      <div
        data-testid="avatar-operation-status"
        role={status?.kind === 'error' ? 'alert' : 'status'}
        className={status?.kind === 'error' ? styles.statusError : styles.statusSuccess}
      >
        {status?.text ?? ''}
      </div>

      {pendingFile && (
        <AvatarCropDialog
          file={pendingFile}
          isSubmitting={uploadMutation.isPending}
          errorMessage={uploadMutation.isError ? uploadMutation.error.message : null}
          onCancel={handleCropCancel}
          onConfirm={handleCropConfirm}
        />
      )}

      {removeDialogOpen && (
        <RemoveAvatarDialog
          isPending={deleteMutation.isPending}
          errorMessage={deleteMutation.isError ? deleteMutation.error.message : null}
          onConfirm={handleRemoveConfirm}
          onCancel={handleRemoveCancel}
        />
      )}
    </div>
  );
};

export default AvatarEditor;
