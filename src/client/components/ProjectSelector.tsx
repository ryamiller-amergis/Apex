import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useProjects } from '../hooks/useProjects';
import {
  useCreateProjectAccessRequests,
  useMyProjectAccessRequests,
  useRequestableProjectCatalog,
} from '../hooks/usePlatformAdmin';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useCanSubmitRfp } from '../hooks/useRfpTriage';
import { useCreateRfpSubmitAccessRequest, useMyRfpSubmitAccessRequests } from '../hooks/useRfpIntake';
import { IS_BETA_RELEASE } from '../config/release';
import { BrandLogo } from './BrandLogo';
import { WhatsNewBanner } from './WhatsNewBanner';
import { UserMenu } from './UserMenu';
import { RfpSubmissionModal } from './RfpSubmissionModal';
import { YourRequestsList } from './YourRequestsList';
import { RfpDetailDrawer } from './RfpDetailDrawer';
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

export const ProjectSelector: React.FC<ProjectSelectorProps> = (props) => {
  const rfpIntakeEnabled = useFeatureFlag('rfp-intake', 'Apex');
  // @feature-flag:rfp-intake start winner=enabled
  return rfpIntakeEnabled ? (
    // @feature-flag:rfp-intake enabled-start
    <RfpEnabledProjectSelector {...props} />
    // @feature-flag:rfp-intake enabled-end
  ) : (
    // @feature-flag:rfp-intake disabled-start
    <ProjectSelectorView {...props} />
    // @feature-flag:rfp-intake disabled-end
  );
  // @feature-flag:rfp-intake end
};

interface IntakeRequestMenuConfig {
  onRequestProduct?: () => void;
  onRequestSubmitAccess?: () => void;
  submitAccessPending?: boolean;
  submitAccessRequesting?: boolean;
  submitAccessError?: string | null;
}

const RfpEnabledProjectSelector: React.FC<ProjectSelectorProps> = (props) => {
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [intakeAccessRequested, setIntakeAccessRequested] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestId = searchParams.get('request');
  const canSubmit = useCanSubmitRfp(Boolean(props.isSuperAdmin));
  const submitAccessQuery = useMyRfpSubmitAccessRequests(!canSubmit);
  const createSubmitAccess = useCreateRfpSubmitAccessRequest();
  const submitAccessPending = intakeAccessRequested
    || (submitAccessQuery.data ?? []).some((request) => request.status === 'pending');

  const openRequest = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('request', id);
    setSearchParams(next);
  };

  const closeRequest = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('request');
    setSearchParams(next);
  };

  return (
    <>
      <ProjectSelectorView
        {...props}
        intakeRequest={{
          onRequestProduct: canSubmit ? () => setIsSubmitOpen(true) : undefined,
          onRequestSubmitAccess: canSubmit || submitAccessPending ? undefined : async () => {
            await createSubmitAccess.mutateAsync();
            setIntakeAccessRequested(true);
          },
          submitAccessPending,
          submitAccessRequesting: createSubmitAccess.isPending,
          submitAccessError: createSubmitAccess.error?.message ?? null,
        }}
        afterGrid={
          canSubmit ? (
            <YourRequestsList onOpenRequest={openRequest} />
          ) : undefined
        }
      />
      {isSubmitOpen && canSubmit && (
        // data-testid-exempt — root dialog already has rfp-submission-modal
        <RfpSubmissionModal
          onClose={() => setIsSubmitOpen(false)}
          onSubmitted={(request) => openRequest(request.id)}
        />
      )}
      {requestId && canSubmit && (
        // data-testid-exempt — root dialog already has rfp-detail-drawer
        <RfpDetailDrawer requestId={requestId} onClose={closeRequest} />
      )}
    </>
  );
};

interface RequestMenuProps extends IntakeRequestMenuConfig {
  showProjectAccess: boolean;
  onProjectAccess: () => void;
  'data-testid'?: string;
}

const RequestMenu: React.FC<RequestMenuProps> = ({
  showProjectAccess,
  onProjectAccess,
  onRequestProduct,
  onRequestSubmitAccess,
  submitAccessPending = false,
  submitAccessRequesting = false,
  'data-testid': testId = 'project-selector-request-menu-host',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const closeAndRun = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  return (
    <div className={styles.requestMenu} ref={menuRef} {...{ 'data-testid': testId }}>
      <button
        type="button"
        className={`${styles.requestAccessButton} ${isOpen ? styles.requestMenuTriggerOpen : ''}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Request"
        onClick={() => setIsOpen((open) => !open)}
        {...{ 'data-testid': 'project-selector-request-menu' }}
      >
        Request
        <span className={styles.requestMenuChevron} aria-hidden="true">
          <svg viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5l3-3" />
          </svg>
        </span>
      </button>
      {isOpen && (
        <div
          className={styles.requestMenuList}
          role="menu"
          aria-label="Request"
          {...{ 'data-testid': 'project-selector-request-menu-list' }}
        >
          {showProjectAccess && (
            <button
              type="button"
              role="menuitem"
              className={styles.requestMenuItem}
              onClick={() => closeAndRun(onProjectAccess)}
              {...{ 'data-testid': 'project-selector-request-project-access' }}
            >
              Project access
            </button>
          )}
          {onRequestProduct ? (
            <button
              type="button"
              role="menuitem"
              className={styles.requestMenuItem}
              onClick={() => closeAndRun(onRequestProduct)}
              {...{ 'data-testid': 'rfp-request-product-item' }}
            >
              Request a Product
            </button>
          ) : submitAccessPending ? (
            <button
              type="button"
              role="menuitem"
              className={styles.requestMenuItem}
              disabled
              aria-label="Intake access pending"
              {...{ 'data-testid': 'rfp-submit-access-pending-item' }}
            >
              Intake access pending
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.requestMenuItem}
              disabled={submitAccessRequesting || !onRequestSubmitAccess}
              onClick={() => {
                if (!onRequestSubmitAccess) return;
                void onRequestSubmitAccess();
              }}
              {...{ 'data-testid': 'rfp-submit-access-request-item' }}
            >
              {submitAccessRequesting ? 'Requesting…' : 'Request intake access'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface ProjectSelectorViewProps extends ProjectSelectorProps {
  afterGrid?: React.ReactNode;
  intakeRequest?: IntakeRequestMenuConfig;
}

const ProjectSelectorView: React.FC<ProjectSelectorViewProps> = ({
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
  afterGrid,
  intakeRequest,
}) => {
  const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);
  const { data: projects = [], isLoading, isError } = useProjects();
  const showPlatformAdmin = Boolean(isSuperAdmin && onOpenPlatformAdmin);
  const showRequest = Boolean(intakeRequest) || !isSuperAdmin;
  const showUserMenu = Boolean(onLogout && onThemeChange);

  return (
    <div className={styles.page}>
      {(showPlatformAdmin || showRequest || showUserMenu) && (
        <div className={styles.chrome}>
          {showPlatformAdmin && (
            <button
              type="button"
              className={styles.platformAdminButton}
              onClick={() => onOpenPlatformAdmin?.()}
              {...{ 'data-testid': 'project-selector-platform-admin' }}
            >
              Platform Admin
            </button>
          )}
          {intakeRequest ? (
            <RequestMenu
              showProjectAccess={!isSuperAdmin}
              onProjectAccess={() => setIsRequestModalOpen(true)}
              onRequestProduct={intakeRequest.onRequestProduct}
              onRequestSubmitAccess={intakeRequest.onRequestSubmitAccess}
              submitAccessPending={intakeRequest.submitAccessPending}
              submitAccessRequesting={intakeRequest.submitAccessRequesting}
              {...{ 'data-testid': 'project-selector-request-menu-host' }}
            />
          ) : (
            !isSuperAdmin && (
              <button
                type="button"
                className={styles.requestAccessButton}
                onClick={() => setIsRequestModalOpen(true)}
                {...{ 'data-testid': 'project-selector-request-access' }}
              >
                Request Access
              </button>
            )
          )}
          {onLogout && onThemeChange && (
            // data-testid-exempt
            <UserMenu
              onOpenChangelog={() => onSetShowChangelog?.(true)}
              onThemeChange={onThemeChange}
              onLogout={onLogout}
              theme={theme}
              user={user ?? null}
              hasUnreadChangelog={hasUnreadChangelog ?? false}
            />
          )}
        </div>
      )}
      <div className={styles.header}>
        <div className={styles.logoMark}>
          <BrandLogo beta={IS_BETA_RELEASE} align="center" />
        </div>
        <p className={styles.subtitle}>Select a project to start planning</p>
      </div>

      {hasUnreadChangelog && onSetShowChangelog && onMarkChangelogAsRead && (
        // data-testid-exempt
        <WhatsNewBanner
          currentVersion={whatsNewCurrentVersion}
          onOpenChangelog={() => onSetShowChangelog(true)}
          onMarkAsRead={onMarkChangelogAsRead}
          onToggleShowOnLogin={onToggleShowChangelogOnLogin}
        />
      )}

      {intakeRequest?.submitAccessError && (
        <p className={styles.intakeStatusError} role="alert" {...{ 'data-testid': 'rfp-submit-access-error-banner' }}>
          {intakeRequest.submitAccessError}
        </p>
      )}
      {intakeRequest?.submitAccessPending && (
        <p
          className={styles.intakeStatusBanner}
          role="status"
          aria-live="polite"
          {...{ 'data-testid': 'rfp-submit-access-pending-banner' }}
        >
          Intake access requested. The Apex team will review your request.
        </p>
      )}

      {isLoading ? (
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <span>Loading projects…</span>
        </div>
      ) : isError ? (
        <p className={styles.errorMsg}>Could not load projects. Check your project catalog connection.</p>
      ) : (
        <div className={styles.grid} {...{ 'data-testid': 'project-selector-grid' }}>
          {projects.map((project) => (
            <button
              key={project.id}
              className={`${styles.card} ${project.name === selectedProject ? styles.cardSelected : ''}`}
              onClick={() => onSelect(project.name)}
              type="button"
              {...{ 'data-testid': `project-selector-card-${project.id}` }}
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

      {afterGrid}

      {isRequestModalOpen && (
        // data-testid-exempt — dialog root is marked inside RequestAccessModal
        <RequestAccessModal onClose={() => setIsRequestModalOpen(false)} />
      )}
    </div>
  );
};

interface RequestAccessModalProps {
  onClose: () => void;
}

const RequestAccessModal: React.FC<RequestAccessModalProps> = ({ onClose }) => {
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
    <div className={styles.modalBackdrop} {...{ 'data-testid': 'request-access-modal' }}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-access-title"
        {...{ 'data-testid': 'request-access-dialog' }}
      >
        <div className={styles.modalHeader}>
          <div>
            <h2 id="request-access-title" className={styles.modalTitle}>Request Project Access</h2>
            <p className={styles.modalSubtitle}>
              Choose one or more ADO or non-ADO projects. A platform admin will review your request.
            </p>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="Close request access"
            {...{ 'data-testid': 'request-access-close' }}
          >
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
          <form
            className={styles.requestForm}
            onSubmit={(event) => void handleSubmit(onSubmit)(event)}
            {...{ 'data-testid': 'request-access-form' }}
          >
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
                        {...{ 'data-testid': `request-access-project-${project.id}` }}
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
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onClose}
                disabled={pending}
                {...{ 'data-testid': 'request-access-cancel' }}
              >
                Close
              </button>
              <button
                type="submit"
                className={styles.platformAdminButton}
                disabled={pending || requestableProjects.length === 0}
                {...{ 'data-testid': 'request-access-submit' }}
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
