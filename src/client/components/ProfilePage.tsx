/**
 * FEAT-003 — Modern Profile Page (/profile).
 * Composes FEAT-001 profile hooks, FEAT-002 AvatarEditor, and existing
 * theme / NotificationPreferences contracts with per-section isolation.
 */
import React from 'react';
import { useCurrentProfile, useUpdateCurrentProfile } from '../hooks/useProfile';
import { THEME_CATEGORIES, getThemeOption, getThemesByCategory, type ThemeCategory, type ThemeMode } from '../config/themes';
import { AvatarEditor } from './AvatarEditor';
import { NotificationPreferences } from './NotificationPreferences';
import {
  PROFILE_BIO_MAX_CODE_POINTS,
  countBioCodePoints,
  containsMarkupLikeInput,
  normalizeAndValidateBio,
} from '../../shared/types/profile';
import {
  WalkthroughAnchorKeys,
  anchorTestIdProps,
} from '../../shared/walkthroughAnchors';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import styles from './ProfilePage.module.css';

export interface ProfilePageProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}

const bioSchema = z.object({
  bio: z
    .string()
    .superRefine((value, ctx) => {
      if (containsMarkupLikeInput(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Bio must be plain text without HTML or markup',
        });
        return;
      }
      if (countBioCodePoints(value) > PROFILE_BIO_MAX_CODE_POINTS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Bio must be at most ${PROFILE_BIO_MAX_CODE_POINTS} characters`,
        });
      }
    }),
});

type BioFormValues = z.infer<typeof bioSchema>;

interface SectionErrorProps {
  section: 'identity' | 'bio' | 'theme' | 'notifications';
  message: string;
  onRetry?: () => void;
}

const SectionError: React.FC<SectionErrorProps> = ({ section, message, onRetry }) => (
  <div
    className={styles.sectionError}
    role="alert"
    {...{ 'data-testid': `profile-section-error-${section}` }}
  >
    <div>{message}</div>
    {onRetry && (
      <button type="button" className={styles.retryButton} onClick={onRetry} {...{ 'data-testid': `profile-section-retry-${section}` }}>
        Retry
      </button>
    )}
  </div>
);

/** Merged Identity + Avatar card: avatar left, read-only Azure AD fields right. */
export const ProfileIdentitySection: React.FC = () => {
  const { data, isLoading, isError, refetch } = useCurrentProfile();

  return (
    <section
      className={`${styles.card} ${styles.spanFull}`}
      {...anchorTestIdProps(WalkthroughAnchorKeys.PROFILE_IDENTITY)}
      aria-labelledby="profile-identity-heading"
    >
      <h2 id="profile-identity-heading" className={styles.cardHeading} data-walkthrough-focus>
        Identity
      </h2>
      {isLoading && (
        <div className={styles.identityLayout}>
          <div className={`${styles.skeleton} ${styles.skeletonAvatar}`} />
          <div>
            <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
            <div className={`${styles.skeleton} ${styles.skeletonLong}`} />
          </div>
        </div>
      )}
      {isError && (
        <SectionError
          section="identity"
          message="Identity unavailable"
          onRetry={() => {
            void refetch();
          }}
        />
      )}
      {!isLoading && !isError && data && (
        <div className={styles.identityLayout}>
          <div className={styles.avatarColumn} {...{ 'data-testid': 'profile-avatar-section' }}>
            <AvatarEditor
              key={`${data.userOid}-${data.avatar.version ?? 'none'}`}
              userOid={data.userOid}
              displayName={data.displayName}
              avatarVersion={data.avatar.version}
              uploadControlTestId="profile-avatar-upload"
              removeButtonTestId="profile-avatar-remove"
            />
            {!data.avatar.version && (
              <p className={styles.helperText}>
                No uploaded photo yet — showing your Graph photo or initials. Upload a JPEG, PNG, or
                WebP to personalize.
              </p>
            )}
          </div>
          <dl className={styles.identityList}>
            <div className={styles.identityRow}>
              <dt className={styles.identityLabel}>Display name</dt>
              <dd className={styles.identityValue} {...{ 'data-testid': 'profile-identity-name' }}>
                {data.displayName}
              </dd>
            </div>
            <div className={styles.identityRow}>
              <dt className={styles.identityLabel}>Email</dt>
              <dd className={styles.identityValue} {...{ 'data-testid': 'profile-identity-email' }}>
                {data.email?.trim() ? data.email : 'Email unavailable'}
              </dd>
            </div>
            {data.org && (
              <>
                <div className={styles.orgDivider} role="presentation" />
                <div className={styles.identityRow}>
                  <dt className={styles.identityLabel}>Job title</dt>
                  <dd className={styles.identityValue} {...{ 'data-testid': 'profile-org-job-title' }}>
                    {data.org.jobTitle ?? 'Not set in directory'}
                  </dd>
                </div>
                <div className={styles.identityRow}>
                  <dt className={styles.identityLabel}>Department</dt>
                  <dd className={styles.identityValue} {...{ 'data-testid': 'profile-org-department' }}>
                    {data.org.department ?? 'Not set in directory'}
                  </dd>
                </div>
                {(data.org.officeLocation || data.org.companyName) && (
                  <div className={styles.identityRow}>
                    <dt className={styles.identityLabel}>
                      {data.org.officeLocation ? 'Office' : 'Company'}
                    </dt>
                    <dd className={styles.identityValue} {...{ 'data-testid': 'profile-org-location' }}>
                      {[data.org.officeLocation, data.org.companyName]
                        .filter(Boolean)
                        .join(' · ')}
                    </dd>
                  </div>
                )}
                {data.org.directReports.length > 0 && (
                  <div className={styles.identityRow}>
                    <dt className={styles.identityLabel}>Direct reports</dt>
                    <dd className={styles.identityValue} {...{ 'data-testid': 'profile-org-reports' }}>
                      <ul className={styles.reportsList}>
                        {data.org.directReports.map((report) => (
                          <li key={report.userOid} className={styles.reportsItem}>
                            <span>{report.displayName}</span>
                            {report.jobTitle && (
                              <span className={styles.orgPersonMeta}>{report.jobTitle}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
};

export const ProfileBioSection: React.FC = () => {
  const { data, isLoading, isError, refetch } = useCurrentProfile();
  const updateProfile = useUpdateCurrentProfile();
  const {
    register,
    handleSubmit,
    control,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<BioFormValues>({
    resolver: zodResolver(bioSchema),
    mode: 'onChange',
    defaultValues: { bio: '' },
  });

  const [status, setStatus] = React.useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [hydratedOid, setHydratedOid] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!data) return;
    // Hydrate once per profile identity so failed saves keep the draft.
    if (hydratedOid !== data.userOid) {
      reset({ bio: data.bio ?? '' });
      setHydratedOid(data.userOid);
    }
  }, [data, hydratedOid, reset]);

  const draft = useWatch({ control, name: 'bio' }) ?? '';
  const codePoints = countBioCodePoints(draft);
  const persistedBio = data?.bio ?? '';
  const isUnchanged = draft === persistedBio;
  const hasClientError = Boolean(errors.bio) || codePoints > PROFILE_BIO_MAX_CODE_POINTS || containsMarkupLikeInput(draft);
  const saveDisabled = isUnchanged || hasClientError || isSubmitting || updateProfile.isPending;

  const onSubmit = handleSubmit(async (values) => {
    const normalized = normalizeAndValidateBio(values.bio);
    if (normalized.ok === false) {
      setStatus({ kind: 'error', text: normalized.error });
      return;
    }
    setStatus(null);
    try {
      const updated = await updateProfile.mutateAsync({ bio: normalized.bio });
      reset({ bio: updated.bio ?? '' });
      setStatus({ kind: 'success', text: 'Bio saved.' });
    } catch (err) {
      // Keep the draft in the form (do not reset).
      void getValues('bio');
      setStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to save bio. Your draft is unchanged.',
      });
    }
  });

  return (
    <section className={`${styles.card} ${styles.cardFill}`} {...anchorTestIdProps(WalkthroughAnchorKeys.PROFILE_BIO)} aria-labelledby="profile-bio-heading">
      <h2 id="profile-bio-heading" className={styles.cardHeading} data-walkthrough-focus>
        Bio
      </h2>
      {isLoading && <div className={`${styles.skeleton} ${styles.skeletonLong}`} />}
      {isError && (
        <SectionError
          section="bio"
          message="Bio unavailable"
          onRetry={() => {
            void refetch();
          }}
        />
      )}
      {!isLoading && !isError && (
        <form className={styles.bioForm} onSubmit={onSubmit} noValidate {...{ 'data-testid': 'profile-bio-form' }}>
          <p id="profile-bio-helper" className={styles.helperText}>
            Optional plain-text bio (up to 500 characters). HTML and rich formatting are not supported.
          </p>
          <textarea
            className={styles.bioTextarea}
            {...{ 'data-testid': 'profile-bio-input' }}
            aria-describedby="profile-bio-helper profile-bio-counter profile-bio-error profile-bio-status"
            aria-invalid={Boolean(errors.bio)}
            {...register('bio')}
          />
          <div className={styles.bioMeta}>
            <span
              id="profile-bio-counter"
              {...{ 'data-testid': 'profile-bio-counter' }}
              className={`${styles.bioCounter} ${codePoints > PROFILE_BIO_MAX_CODE_POINTS ? styles.bioCounterOver : ''}`}
            >
              {codePoints}/{PROFILE_BIO_MAX_CODE_POINTS}
            </span>
            <button
              type="submit"
              className={styles.bioSave}
              {...{ 'data-testid': 'profile-bio-save' }}
              disabled={saveDisabled}
            >
              {updateProfile.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {errors.bio && (
            <p id="profile-bio-error" className={styles.fieldError} role="alert">
              {errors.bio.message}
            </p>
          )}
          <div
            id="profile-bio-status"
            className={styles.statusMessage}
            role={status?.kind === 'error' ? 'alert' : 'status'}
            {...{ 'data-testid': 'profile-bio-status' }}
          >
            {status?.text ?? ''}
          </div>
        </form>
      )}
    </section>
  );
};

interface ProfileThemeSectionProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}

export const ProfileThemeSection: React.FC<ProfileThemeSectionProps> = ({ theme, onThemeChange }) => {
  const [selected, setSelected] = React.useState<ThemeMode>(theme);
  const [category, setCategory] = React.useState<ThemeCategory>(
    () => getThemeOption(theme)?.category ?? 'classic',
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelected(theme);
    setCategory(getThemeOption(theme)?.category ?? 'classic');
  }, [theme]);

  const handleSelect = (next: ThemeMode) => {
    const previous = selected;
    setSelected(next);
    setError(null);
    try {
      onThemeChange(next);
    } catch (err) {
      setSelected(previous);
      setError(err instanceof Error ? err.message : 'Failed to update theme.');
    }
  };

  const visibleThemes = getThemesByCategory(category);
  const activeCategory = THEME_CATEGORIES.find((item) => item.value === category);

  return (
    <section className={`${styles.card} ${styles.cardFill}`} {...anchorTestIdProps(WalkthroughAnchorKeys.PROFILE_THEME)} aria-labelledby="profile-theme-heading">
      <h2 id="profile-theme-heading" className={styles.cardHeading} data-walkthrough-focus>
        Theme
      </h2>

      <div
        className={styles.themeCategoryGroup}
        role="radiogroup"
        aria-label="Theme category"
        data-testid="profile-theme-category-group"
      >
        {THEME_CATEGORIES.map((item) => {
          const isActive = category === item.value;
          return (
            <button
              key={item.value}
              type="button"
              className={`${styles.themeCategoryRadio} ${isActive ? styles.themeCategoryRadioActive : ''}`}
              onClick={() => setCategory(item.value)}
              role="radio"
              aria-checked={isActive}
              aria-label={`${item.label}: ${item.description}`}
              data-testid={`profile-theme-category-${item.value}`}
            >
              <span className={styles.themeCategoryDot} aria-hidden="true" />
              <span className={styles.themeCategoryCopy}>
                <span className={styles.themeCategoryLabel}>{item.label}</span>
                <span className={styles.themeCategoryDesc}>{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      {activeCategory && (
        <p className={styles.themeCategoryHint} data-testid="profile-theme-category-hint">
          {activeCategory.label} themes
        </p>
      )}

      <div className={styles.themeGrid} role="radiogroup" aria-label={`${activeCategory?.label ?? 'Theme'} options`}>
        {visibleThemes.map((option) => {
          const isActive = selected === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={`${styles.themeCard} ${isActive ? styles.themeCardActive : ''} ${option.category === 'neon' ? styles.themeCardNeon : ''}`}
              onClick={() => handleSelect(option.value)}
              role="radio"
              aria-checked={isActive}
              aria-label={`${option.label}: ${option.description}`}
              {...{ 'data-testid': `profile-theme-option-${option.value}` }}
              style={{ '--theme-preview': option.preview } as React.CSSProperties}
            >
              <span className={styles.themePreview} aria-hidden="true">
                <span className={styles.themeAccents}>
                  {option.accents.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
              </span>
              <span className={styles.themeLabel}>{option.label}</span>
              <span className={styles.themeDesc}>{option.description}</span>
              {isActive && (
                <span className={styles.themeCheck} aria-hidden="true">
                  <svg viewBox="0 0 12 12">
                    <path d="M2.5 6.2L4.8 8.5 9.5 3.5" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <SectionError section="theme" message={error} />
      )}
    </section>
  );
};

export const ProfileNotificationSection: React.FC = () => (
  <section
    className={`${styles.card} ${styles.spanFull}`}
    {...anchorTestIdProps(WalkthroughAnchorKeys.PROFILE_NOTIFICATIONS)}
    aria-labelledby="profile-notification-heading"
  >
    <h2 id="profile-notification-heading" className={styles.cardHeading} data-walkthrough-focus>
      Notification Preferences
    </h2>
    <NotificationPreferences showContainedErrors />
  </section>
);

export const ProfilePage: React.FC<ProfilePageProps> = ({ theme, onThemeChange }) => (
  <div className={styles.page} {...{ 'data-testid': 'profile-page' }}>
    <h1 className={styles.title}>Profile</h1>
    <p className={styles.subtitle}>
      Manage your Apex identity, avatar, bio, theme, and notification preferences.
    </p>
    <div className={styles.grid}>
      <ProfileIdentitySection />
      <ProfileBioSection />
      <ProfileThemeSection theme={theme} onThemeChange={onThemeChange} />
      <ProfileNotificationSection />
    </div>
  </div>
);

export default ProfilePage;
