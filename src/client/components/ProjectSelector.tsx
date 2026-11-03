import React, { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useProjects } from '../hooks/useProjects';
import {
  useCreateProjectAccessRequests,
  useMyProjectAccessRequests,
  useRequestableProjectCatalog,
} from '../hooks/usePlatformAdmin';
import { IS_BETA_RELEASE } from '../config/release';
import { sortByLabel } from '../utils/sortByLabel';
import { BrandLogo } from './BrandLogo';
import { WhatsNewBanner } from './WhatsNewBanner';
import { UserMenu } from './UserMenu';
import type { ThemeMode } from '../hooks/useAppShell';
import styles from './ProjectSelector.module.css';

const requestAccessSchema = z.object({
  projects: z.array(z.string()).min(1, 'Select at least one project.'),
});

type RequestAccessFormValues = z.infer<typeof requestAccessSchema>;

interface ProjectSelectorProps {
  selectedProject: string;
  onSelect: (project: string) => void;
  isSuperAdmin?: boolean;
  onOpenPlatformAdmin?: () => void;
  hasUnreadChangelog?: boolean;
  showChangelogOnLogin?: boolean;
  showChangelog?: boolean;
  onSetShowChangelog?: (show: boolean) => void;
  onMarkChangelogAsRead?: () => void;
  onToggleShowChangelogOnLogin?: (show: boolean) => void;
  whatsNewCurrentVersion?: string | null;
  user?: { name: string; email?: string } | null;
  theme?: ThemeMode;
  onThemeChange?: (theme: ThemeMode) => void;
  onLogout?: () => void;
}

export const ProjectSelector: React.FC<ProjectSelectorProps> = ({
  selectedProject,
  onSelect,
  isSuperAdmin = false,
  onOpenPlatformAdmin,
  hasUnreadChangelog,
  onSetShowChangelog,
  onMarkChangelogAsRead,
  onToggleShowChangelogOnLogin,
  whatsNewCurrentVersion,
  user,
  theme = 'dark',
  onThemeChange,
  onLogout,
}) => {
  const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);
  const { data: projects = [], isLoading, isError } = useProjects();
  const sortedProjects = useMemo(
    () => sortByLabel(projects, (project) => project.name),
    [projects],
  );

  return (
    <div className={styles.page}>
      {onLogout && onThemeChange && (
        <div className={styles.userMenuCorner}>
          {/* data-testid-exempt — UserMenu owns its menu ids */}
          <UserMenu
            onOpenChangelog={() => onSetShowChangelog?.(true)}
            onThemeChange={onThemeChange}
            onLogout={onLogout}
            theme={theme}
            user={user ?? null}
            hasUnreadChangelog={hasUnreadChangelog ?? false}
          />
        </div>
      )}
      <div className={styles.header}>
        <div className={styles.logoMark}>
          <BrandLogo beta={IS_BETA_RELEASE} align="center" />
        </div>
        <p className={styles.subtitle}>Select a project to start planning</p>
        <div className={styles.actions}>
          {isSuperAdmin && onOpenPlatformAdmin && (
            <button
              type="button"
              className={styles.platformAdminButton}
              onClick={onOpenPlatformAdmin}
              {...{ 'data-testid': 'project-selector-platform-admin' }}
            >
              Platform Admin
            </button>
          )}
          {!isSuperAdmin && (
            <button
              type="button"
              className={styles.requestAccessButton}
              onClick={() => setIsRequestModalOpen(true)}
              {...{ 'data-testid': 'project-selector-request-access' }}
            >
              Request Access
            </button>
          )}
        </div>
      </div>

      {hasUnreadChangelog && onSetShowChangelog && onMarkChangelogAsRead && (
        <>
          {/* data-testid-exempt — WhatsNewBanner owns whats-new-banner root id */}
          <WhatsNewBanner
            currentVersion={whatsNewCurrentVersion}
            onOpenChangelog={() => onSetShowChangelog(true)}
            onMarkAsRead={onMarkChangelogAsRead}
            onToggleShowOnLogin={onToggleShowChangelogOnLogin}
          />
        </>
      )}

      {isLoading ? (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <span>Loading projects…</span>
        </div>
      ) : isError ? (
        <p className={styles.errorMsg}>Could not load projects. Check your project catalog connection.</p>
      ) : (
        <div className={styles.grid}>
          {sortedProjects.map((project) => (
            <button
              key={project.id}
              className={`${styles.card} ${project.name === selectedProject ? styles.cardSelected : ''}`}
              onClick={() => onSelect(project.name)}
              type="button"
              {...{ 'data-testid': `project-selector-${project.id}` }}
            >
              <div className={styles.cardIcon}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </div>
              <div className={styles.cardBody}>
                <span className={styles.cardName}>{project.name}</span>
                {project.description && (
                  <span className={styles.cardMeta}>{project.description}</span>
                )}
              </div>
              {project.name === selectedProject && (
                <div className={styles.cardBadge}>
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                  </svg>
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {isRequestModalOpen && (
        <RequestAccessModal onClose={() => setIsRequestModalOpen(false)} {...{ 'data-testid': 'project-request-access-modal' }} />
      )}
    </div>
  );
};

interface RequestAccessModalProps {
  onClose: () => void;
  'data-testid'?: string;
}

const RequestAccessModal: React.FC<RequestAccessModalProps> = ({ onClose, 'data-testid': dataTestId }) => {
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const {
    data: requestableProjects = [],
    isLoading: catalogLoading,
    isError: catalogIsError,
    error: catalogError,
  } = useRequestableProjectCatalog();
  const {
    data: myRequests = [],
    isLoading: requestsLoading,
  } = useMyProjectAccessRequests();
  const createRequests = useCreateProjectAccessRequests();
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RequestAccessFormValues>({
    resolver: zodResolver(requestAccessSchema),
    defaultValues: { projects: [] },
  });

  const selectedProjects = useWatch({ control, name: 'projects' }) ?? [];
  const pendingRequests = useMemo(() => {
    return myRequests.filter((request) => request.status === 'pending');
  }, [myRequests]);
  const loadError = catalogError instanceof Error ? catalogError.message : 'Could not load requestable projects.';
  const pending = isSubmitting || createRequests.isPending;

  const onSubmit = async (values: RequestAccessFormValues) => {
    setSubmitMessage(null);
    const created = await createRequests.mutateAsync(values);
    reset({ projects: [] });
    setSubmitMessage(
      created.length === 0
        ? 'No new requests were created.'
        : `Requested access to ${created.length} project${created.length === 1 ? '' : 's'}.`,
    );
  };

  return (
    <div className={styles.modalBackdrop} {...(dataTestId ? { 'data-testid': dataTestId } : {})}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="request-access-title" {...{ 'data-testid': 'project-request-access-dialog' }}>
        <div className={styles.modalHeader}>
          <div>
            <h2 id="request-access-title" className={styles.modalTitle}>Request Project Access</h2>
            <p className={styles.modalSubtitle}>
              Choose one or more ADO or non-ADO projects. A platform admin will review your request.
            </p>
          </div>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close request access" {...{ 'data-testid': 'project-request-access-close' }}>
            &times;
          </button>
        </div>

        {pendingRequests.length > 0 && (
          <div className={styles.pendingPanel}>
            <h3 className={styles.pendingTitle}>Pending requests</h3>
            <div className={styles.pendingChips}>
              {pendingRequests.map((request) => (
                <span key={request.id} className={styles.pendingChip}>{request.project}</span>
              ))}
            </div>
          </div>
        )}

        {catalogLoading || requestsLoading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <span>Loading requestable projects...</span>
          </div>
        ) : catalogIsError ? (
          <p className={styles.errorMsg}>{loadError}</p>
        ) : (
          <form className={styles.requestForm} onSubmit={(event) => void handleSubmit(onSubmit)(event)} {...{ 'data-testid': 'project-request-access-form' }}>
            {requestableProjects.length === 0 ? (
              <p className={styles.emptyText}>No additional projects are available to request.</p>
            ) : (
              <div className={styles.projectChecklist}>
                {requestableProjects.map((project) => {
                  const checked = selectedProjects.includes(project.name);
                  return (
                    <label
                      key={project.id}
                      className={`${styles.projectOption} ${checked ? styles.projectOptionChecked : ''}`}
                    >
                      <input
                        type="checkbox"
                        value={project.name}
                        className={styles.projectCheckbox}
                        disabled={pending}
                        {...register('projects')}
                        {...{ 'data-testid': `project-request-access-${project.id}` }}
                      />
                      <span>
                        <span className={styles.projectOptionName}>{project.name}</span>
                        {project.description && (
                          <span className={styles.projectOptionMeta}>{project.description}</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {errors.projects && <p className={styles.fieldError}>{errors.projects.message}</p>}
            {createRequests.error && <p className={styles.errorMsg}>{createRequests.error.message}</p>}
            {submitMessage && <p className={styles.successMsg}>{submitMessage}</p>}

            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={pending} {...{ 'data-testid': 'project-request-access-cancel' }}>
                Close
              </button>
              <button
                type="submit"
                className={styles.platformAdminButton}
                disabled={pending || requestableProjects.length === 0}
                {...{ 'data-testid': 'project-request-access-submit' }}
              >
                {pending ? 'Requesting...' : 'Submit request'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
