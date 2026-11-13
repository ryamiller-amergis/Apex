import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  RELEASE_PLATFORM_COLORS,
  RELEASE_PLATFORM_PRESETS,
  slugifyReleasePlatform,
  type ReleasePlatform,
  type ReleasePlatformColor,
} from '../../shared/types/releasePlatforms';
import styles from './ReleasePlatformModal.module.css';

const customPlatformSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Platform name is required')
    .max(60, 'Platform name must be 60 characters or fewer'),
  color: z.enum(RELEASE_PLATFORM_COLORS),
});

type CustomPlatformFormValues = z.infer<typeof customPlatformSchema>;

const COLOR_DOT_CLASSES: Record<ReleasePlatformColor, string> = {
  blue: styles.dotBlue,
  teal: styles.dotTeal,
  purple: styles.dotPurple,
  amber: styles.dotAmber,
  emerald: styles.dotEmerald,
  rose: styles.dotRose,
  slate: styles.dotSlate,
};

interface ReleasePlatformModalProps {
  project: string;
  platforms: ReleasePlatform[];
  isBusy?: boolean;
  onClose: () => void;
  onCreatePlatform: (input: { name: string; color: ReleasePlatformColor }) => Promise<unknown>;
  onReorderPlatforms: (platformIds: string[]) => Promise<unknown>;
  onDeletePlatform: (platformId: string) => Promise<unknown>;
}

export const ReleasePlatformModal: React.FC<ReleasePlatformModalProps> = ({
  project,
  platforms,
  isBusy = false,
  onClose,
  onCreatePlatform,
  onReorderPlatforms,
  onDeletePlatform,
}) => {
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CustomPlatformFormValues>({
    resolver: zodResolver(customPlatformSchema),
    defaultValues: {
      name: '',
      color: 'blue',
    },
  });

  const existingSlugs = new Set(platforms.map((p) => p.slug));

  const handleAddPreset = async (name: string, color: ReleasePlatformColor) => {
    setActionError(null);
    try {
      await onCreatePlatform({ name, color });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add platform');
    }
  };

  const onSubmitCustom = async (values: CustomPlatformFormValues) => {
    setActionError(null);
    const slug = slugifyReleasePlatform(values.name);
    if (!slug) {
      setActionError('Platform name must contain letters or numbers');
      return;
    }
    try {
      await onCreatePlatform({ name: values.name.trim(), color: values.color });
      reset({ name: '', color: values.color });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create platform');
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= platforms.length) return;
    setActionError(null);
    const orderedIds = platforms.map((p) => p.id);
    const [moved] = orderedIds.splice(index, 1);
    orderedIds.splice(targetIndex, 0, moved);
    try {
      await onReorderPlatforms(orderedIds);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reorder platforms');
    }
  };

  const handleDelete = async (platformId: string) => {
    setActionError(null);
    try {
      await onDeletePlatform(platformId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete platform');
    }
  };

  return (
    <div
      className={styles.overlay}
      role="presentation"
      data-testid="release-platforms-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-platforms-modal-title"
        data-testid="release-platforms-modal"
      >
        <div className={styles.header}>
          <div>
            <h3 id="release-platforms-modal-title" className={styles.headerTitle}>
              Target Platforms — {project}
            </h3>
            <p className={styles.headerSubtitle}>
              Configure the target platforms your team ships to (for example Desktop only, or Desktop + Mobile).
              ADO tags like <code>Desktop</code> or <code>Platform:Mobile</code> match automatically.
            </p>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            data-testid="release-platforms-modal-close"
            onClick={onClose}
            aria-label="Close target platforms modal"
          >
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div>
            <div className={styles.sectionLabel}>Quick-Add Presets</div>
            <div className={styles.presetRow}>
              {RELEASE_PLATFORM_PRESETS.map((preset) => {
                const alreadyAdded = existingSlugs.has(preset.slug);
                return (
                  <button
                    key={preset.slug}
                    type="button"
                    data-testid={`release-platform-preset-${preset.slug}`}
                    className={`${styles.presetBtn} ${alreadyAdded ? styles.presetBtnAdded : ''}`}
                    disabled={alreadyAdded || isBusy}
                    onClick={() => {
                      void handleAddPreset(preset.name, preset.color);
                    }}
                  >
                    <span className={`${styles.colorDot} ${COLOR_DOT_CLASSES[preset.color]}`} />
                    <span>{alreadyAdded ? `✓ ${preset.name}` : `+ ${preset.name}`}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className={styles.sectionLabel}>Add Custom Platform</div>
            <form
              className={styles.customForm}
              data-testid="release-platform-custom-form"
              onSubmit={handleSubmit(onSubmitCustom)}
            >
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel} htmlFor="release-platform-custom-name">
                  Platform Name
                </label>
                <input
                  id="release-platform-custom-name"
                  type="text"
                  className={styles.input}
                  data-testid="release-platform-custom-name"
                  placeholder="e.g., Windows Client, Kiosk, Edge"
                  {...register('name')}
                />
              </div>

              <div className={styles.colorFieldGroup}>
                <label className={styles.fieldLabel} htmlFor="release-platform-custom-color">
                  Badge Color
                </label>
                <select
                  id="release-platform-custom-color"
                  className={styles.select}
                  data-testid="release-platform-custom-color"
                  {...register('color')}
                >
                  {RELEASE_PLATFORM_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {color.charAt(0).toUpperCase() + color.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                className={styles.addBtn}
                data-testid="release-platform-custom-submit"
                disabled={isBusy || isSubmitting}
              >
                Add Platform
              </button>
            </form>
            {errors.name && (
              <div className={styles.errorBox} role="alert" style={{ marginTop: 8 }}>
                {errors.name.message}
              </div>
            )}
          </div>

          {actionError && (
            <div className={styles.errorBox} role="alert" data-testid="release-platform-error">
              {actionError}
            </div>
          )}

          <div>
            <div className={styles.sectionLabel}>
              Configured Platforms ({platforms.length})
            </div>
            {platforms.length === 0 ? (
              <div className={styles.emptyState} data-testid="release-platforms-empty">
                No target platforms configured yet. Teams with a single deployment target can leave this
                empty or add one platform (such as Desktop); multi-platform teams can add each target above.
              </div>
            ) : (
              <div className={styles.platformList} data-testid="release-platforms-list">
                {platforms.map((platform, idx) => (
                  <div
                    key={platform.id}
                    className={styles.platformItem}
                    data-testid={`release-platform-row-${platform.slug}`}
                  >
                    <div className={styles.platformLeft}>
                      <span className={styles.platformBadge}>
                        <span className={`${styles.colorDot} ${COLOR_DOT_CLASSES[platform.color]}`} />
                        <span>{platform.name}</span>
                      </span>
                      <span className={styles.platformSlug}>tag: {platform.slug}</span>
                    </div>

                    <div className={styles.platformActions}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        data-testid={`release-platform-up-${platform.slug}`}
                        disabled={idx === 0 || isBusy}
                        onClick={() => {
                          void handleMove(idx, -1);
                        }}
                        title="Move platform up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        data-testid={`release-platform-down-${platform.slug}`}
                        disabled={idx === platforms.length - 1 || isBusy}
                        onClick={() => {
                          void handleMove(idx, 1);
                        }}
                        title="Move platform down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={styles.deleteBtn}
                        data-testid={`release-platform-delete-${platform.slug}`}
                        disabled={isBusy}
                        onClick={() => {
                          void handleDelete(platform.id);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            Platform readiness updates immediately across all releases in {project}.
          </span>
          <button
            type="button"
            className={styles.doneBtn}
            data-testid="release-platforms-modal-done"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
