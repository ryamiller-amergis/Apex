import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useProjects, type AdoProject } from '../hooks/useProjects';
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
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { RfpSubmissionModal } from './RfpSubmissionModal';
import { YourRequestsList } from './YourRequestsList';
import { RfpRequestWizard } from './RfpRequestWizard';
import type { ThemeMode } from '../hooks/useAppShell';
import type { PlatformAdminProject } from '../../shared/types/platformAdmin';
import styles from './ProjectSelector.module.css';

const requestAccessSchema = z.object({
  projects: z.array(z.string()).min(1, 'Select at least one project.'),
});

type RequestAccessFormValues = z.infer<typeof requestAccessSchema>;
type PlatformScreen = 'home' | 'projects' | 'new' | 'requests';

interface ProjectSelectorProps {
  selectedProject: string;
  onSelect: (project: string) => void;
  isSuperAdmin?: boolean;
  showNotifications?: boolean;
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
        // data-testid-exempt — root dialog already has rfp-wizard
        <RfpRequestWizard mode="requester" requestId={requestId} canManage={false} onClose={closeRequest} />
      )}
    </>
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
  showNotifications = false,
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
  const [screen, setScreen] = useState<PlatformScreen>('home');
  const [query, setQuery] = useState('');
  const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);
  const { data: projects = [], isLoading, isError } = useProjects();
  const catalogQuery = useRequestableProjectCatalog(!isSuperAdmin);
  const accessRequestsQuery = useMyProjectAccessRequests(!isSuperAdmin);
  const showPlatformAdmin = Boolean(isSuperAdmin && onOpenPlatformAdmin);
  const showNewProject = !isSuperAdmin || Boolean(intakeRequest);
  const showRequests = !isSuperAdmin || Boolean(afterGrid);
  const requestableProjects = catalogQuery.data ?? [];
  const pendingAccess = useMemo(
    () => (accessRequestsQuery.data ?? []).filter((request) => request.status === 'pending'),
    [accessRequestsQuery.data],
  );
  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(needle));
  }, [projects, query]);
  const continueProject = projects.find((project) => project.name === selectedProject) ?? projects[0];
  const welcomeName = user?.name?.trim().split(/\s+/)[0];

  const openRequestAccess = () => setIsRequestModalOpen(true);

  return (
    <div className={styles.shell}>
      <nav className={styles.nav} aria-label="Platform" {...{ 'data-testid': 'project-selector-nav' }}>
        <div className={styles.brand}>
          <BrandLogo beta={IS_BETA_RELEASE} align="start" />
        </div>
        <button
          type="button"
          className={`${styles.navButton} ${screen === 'home' ? styles.navButtonActive : ''}`}
          aria-current={screen === 'home' ? 'page' : undefined}
          onClick={() => setScreen('home')}
          {...{ 'data-testid': 'project-selector-nav-home' }}
        >
          Home
        </button>
        <button
          type="button"
          className={`${styles.navButton} ${screen === 'projects' ? styles.navButtonActive : ''}`}
          aria-current={screen === 'projects' ? 'page' : undefined}
          onClick={() => setScreen('projects')}
          {...{ 'data-testid': 'project-selector-nav-projects' }}
        >
          Projects
        </button>
        {showNewProject && (
          <button
            type="button"
            className={`${styles.navButton} ${screen === 'new' ? styles.navButtonActive : ''}`}
            aria-current={screen === 'new' ? 'page' : undefined}
            onClick={() => setScreen('new')}
            {...{ 'data-testid': 'project-selector-nav-new' }}
          >
            New project
          </button>
        )}
        {showRequests && (
          <button
            type="button"
            className={`${styles.navButton} ${screen === 'requests' ? styles.navButtonActive : ''}`}
            aria-current={screen === 'requests' ? 'page' : undefined}
            onClick={() => setScreen('requests')}
            {...{ 'data-testid': 'project-selector-nav-requests' }}
          >
            Requests
          </button>
        )}
        <div className={styles.navSpacer} />
        {showPlatformAdmin && (
          <div className={styles.navFooter}>
            <button
              type="button"
              className={styles.navButton}
              onClick={() => onOpenPlatformAdmin?.()}
              {...{ 'data-testid': 'project-selector-platform-admin' }}
            >
              Platform Admin
            </button>
          </div>
        )}
      </nav>

      <div className={styles.main}>
        <div className={styles.topbar}>
          {showNotifications && <NotificationBell />}
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

        <div className={styles.content}>
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

          {screen === 'home' && (
            <HomeScreen
              welcomeName={welcomeName}
              showNewProject={showNewProject}
              hasIntake={Boolean(intakeRequest)}
              isLoading={isLoading}
              isError={isError}
              projects={filteredProjects}
              continueProject={continueProject}
              selectedProject={selectedProject}
              query={query}
              onQuery={setQuery}
              onSelect={onSelect}
              onBrowse={() => setScreen('projects')}
              onNew={() => setScreen('new')}
            />
          )}

          {screen === 'projects' && (
            <ProjectsScreen
              isLoading={isLoading}
              isError={isError}
              projects={projects}
              selectedProject={selectedProject}
              onSelect={onSelect}
              showRequestable={!isSuperAdmin}
              requestableProjects={requestableProjects}
              catalogLoading={catalogQuery.isLoading}
              onRequestAccess={openRequestAccess}
            />
          )}

          {screen === 'new' && (
            <NewProjectScreen
              showJoin={!isSuperAdmin}
              requestableProjects={requestableProjects}
              catalogLoading={catalogQuery.isLoading}
              intakeRequest={intakeRequest}
              onRequestAccess={openRequestAccess}
            />
          )}

          {screen === 'requests' && (
            <RequestsScreen pendingProjects={pendingAccess.map((request) => request.project)} afterGrid={afterGrid} />
          )}
        </div>
      </div>

      {isRequestModalOpen && (
        // data-testid-exempt — dialog root is marked inside RequestAccessModal
        <RequestAccessModal onClose={() => setIsRequestModalOpen(false)} />
      )}
    </div>
  );
};

interface HomeScreenProps {
  welcomeName?: string;
  showNewProject: boolean;
  hasIntake: boolean;
  isLoading: boolean;
  isError: boolean;
  projects: AdoProject[];
  continueProject?: AdoProject;
  selectedProject: string;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (project: string) => void;
  onBrowse: () => void;
  onNew: () => void;
}

const HomeScreen: React.FC<HomeScreenProps> = ({
  welcomeName,
  showNewProject,
  hasIntake,
  isLoading,
  isError,
  projects,
  continueProject,
  selectedProject,
  query,
  onQuery,
  onSelect,
  onBrowse,
  onNew,
}) => (
  <>
    <div className={styles.stack}>
      <h1 className={styles.title}>{welcomeName ? `Welcome back, ${welcomeName}` : 'Welcome back'}</h1>
      <p className={styles.lede}>
        {showNewProject
          ? 'Open a project you already have, or start one that is not here yet.'
          : 'Open a project to start planning.'}
      </p>
    </div>

    {!isLoading && !isError && continueProject && (
      <div className={styles.continuePanel}>
        <div className={styles.continueCopy}>
          <p className={styles.kicker}>Continue</p>
          <span className={styles.projectName}>{continueProject.name}</span>
          {continueProject.description && (
            <span className={styles.projectMeta}>{continueProject.description}</span>
          )}
        </div>
        <button
          type="button"
          className={styles.openButton}
          onClick={() => onSelect(continueProject.name)}
          {...{ 'data-testid': 'project-selector-continue' }}
        >
          Open
        </button>
      </div>
    )}

    <div className={styles.homeLayout}>
      <div className={styles.projectColumn}>
        <div className={styles.columnHeader}>
          <h2 className={styles.sectionTitle}>Your projects</h2>
          <input
            type="search"
            className={styles.search}
            value={query}
            placeholder="Search projects"
            onChange={(event) => onQuery(event.target.value)}
            {...{ 'data-testid': 'project-selector-search' }}
          />
        </div>
        <ProjectResults
          isLoading={isLoading}
          isError={isError}
          projects={projects}
          selectedProject={selectedProject}
          onSelect={onSelect}
          emptyLabel={query.trim() ? 'No project matches that search.' : 'You do not have a project yet.'}
        />
        <button
          type="button"
          className={styles.textButton}
          onClick={onBrowse}
          {...{ 'data-testid': 'project-selector-browse' }}
        >
          Browse all projects
        </button>
      </div>

      {showNewProject && (
        <aside className={styles.aside}>
          <h2 className={styles.sectionTitle}>Start something new</h2>
          <p className={styles.sectionCopy}>
            {hasIntake
              ? 'Join a project you cannot see yet, or ask the team to stand up a new one.'
              : 'Ask for access to a project you cannot see yet.'}
          </p>
          <button
            type="button"
            className={styles.requestAccessButton}
            onClick={onNew}
            {...{ 'data-testid': 'project-selector-start-new' }}
          >
            Start a new project
          </button>
        </aside>
      )}
    </div>
  </>
);

interface ProjectsScreenProps {
  isLoading: boolean;
  isError: boolean;
  projects: AdoProject[];
  selectedProject: string;
  onSelect: (project: string) => void;
  showRequestable: boolean;
  requestableProjects: PlatformAdminProject[];
  catalogLoading: boolean;
  onRequestAccess: () => void;
}

const ProjectsScreen: React.FC<ProjectsScreenProps> = ({
  isLoading,
  isError,
  projects,
  selectedProject,
  onSelect,
  showRequestable,
  requestableProjects,
  catalogLoading,
  onRequestAccess,
}) => (
  <>
    <div className={styles.stack}>
      <h1 className={styles.title}>Projects</h1>
      <p className={styles.lede}>Open one you belong to. If it is missing, request access.</p>
    </div>
    <h2 className={styles.sectionTitle}>You can open</h2>
    <ProjectResults
      isLoading={isLoading}
      isError={isError}
      projects={projects}
      selectedProject={selectedProject}
      onSelect={onSelect}
      emptyLabel="You do not have a project yet."
    />
    {showRequestable && (
      <>
        <h2 className={styles.sectionTitle}>You can request</h2>
        {catalogLoading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <span>Loading requestable projects…</span>
          </div>
        ) : requestableProjects.length === 0 ? (
          <p className={styles.emptyText}>No additional projects are available to request.</p>
        ) : (
          <>
            <button
              type="button"
              className={styles.requestAccessButton}
              onClick={onRequestAccess}
              {...{ 'data-testid': 'project-selector-projects-request-access' }}
            >
              Request access
            </button>
            <ul className={styles.catalogList}>
              {requestableProjects.map((project) => (
                <li key={project.id} className={styles.catalogItem}>
                  <span className={styles.projectName}>{project.name}</span>
                  {project.description && <span className={styles.projectMeta}>{project.description}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    )}
  </>
);

interface NewProjectScreenProps {
  showJoin: boolean;
  requestableProjects: PlatformAdminProject[];
  catalogLoading: boolean;
  intakeRequest?: IntakeRequestMenuConfig;
  onRequestAccess: () => void;
}

const NewProjectScreen: React.FC<NewProjectScreenProps> = ({
  showJoin,
  requestableProjects,
  catalogLoading,
  intakeRequest,
  onRequestAccess,
}) => {
  const availableCount = requestableProjects.length;
  return (
    <>
      <div className={styles.stack}>
        <h1 className={styles.title}>New project</h1>
        <p className={styles.lede}>
          {intakeRequest && showJoin
            ? 'Two paths, one page. Join work that already exists, or propose work that should.'
            : intakeRequest
              ? 'Describe the project that should exist. You stay here until it is ready to open.'
              : 'Join a project that already exists.'}
        </p>
      </div>

      <div className={styles.choiceGrid}>
        {showJoin && (
          <section className={styles.choiceCard}>
            <div className={styles.stack}>
              <h2 className={styles.sectionTitle}>Join an existing project</h2>
              <p className={styles.sectionCopy}>
                Pick from the projects you do not belong to yet. A platform admin reviews the request.
              </p>
              <p className={styles.choiceMeta} aria-live="polite">
                {catalogLoading
                  ? 'Checking which projects are available…'
                  : availableCount === 0
                    ? 'No additional projects are available to request right now.'
                    : `${availableCount} project${availableCount === 1 ? '' : 's'} available to request.`}
              </p>
            </div>
            <div className={styles.choiceActions}>
              <button
                type="button"
                className={styles.requestAccessButton}
                onClick={onRequestAccess}
                {...{ 'data-testid': intakeRequest ? 'project-selector-request-project-access' : 'project-selector-request-access' }}
              >
                Request access
              </button>
            </div>
          </section>
        )}

        {intakeRequest && (
          <section className={styles.choiceCard}>
            <div className={styles.stack}>
              <h2 className={styles.sectionTitle}>Start a new one</h2>
              <p className={styles.sectionCopy}>
                Tell the Apex team what the project is for. You stay here until that project is ready to open.
              </p>
              <p className={styles.choiceMeta}>
                {intakeRequest.onRequestProduct
                  ? 'Opens the product request form.'
                  : intakeRequest.submitAccessPending
                    ? 'Your intake access request is awaiting review.'
                    : 'You need intake access before you can submit a product request.'}
              </p>
            </div>
            <div className={styles.choiceActions}>
              {intakeRequest.onRequestProduct ? (
                <button
                  type="button"
                  className={styles.platformAdminButton}
                  onClick={intakeRequest.onRequestProduct}
                  {...{ 'data-testid': 'rfp-request-product-item' }}
                >
                  Request a product
                </button>
              ) : intakeRequest.submitAccessPending ? (
                <button
                  type="button"
                  className={styles.platformAdminButton}
                  disabled
                  aria-label="Intake access pending"
                  {...{ 'data-testid': 'rfp-submit-access-pending-item' }}
                >
                  Intake access pending
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.platformAdminButton}
                  disabled={intakeRequest.submitAccessRequesting || !intakeRequest.onRequestSubmitAccess}
                  onClick={() => {
                    if (!intakeRequest.onRequestSubmitAccess) return;
                    void intakeRequest.onRequestSubmitAccess();
                  }}
                  {...{ 'data-testid': 'rfp-submit-access-request-item' }}
                >
                  {intakeRequest.submitAccessRequesting ? 'Requesting…' : 'Request intake access'}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
};

interface RequestsScreenProps {
  pendingProjects: string[];
  afterGrid?: React.ReactNode;
}

const RequestsScreen: React.FC<RequestsScreenProps> = ({ pendingProjects, afterGrid }) => (
  <>
    <div className={styles.stack}>
      <h1 className={styles.title}>Requests</h1>
      <p className={styles.lede}>Access asks and new-project asks live here.</p>
    </div>
    {pendingProjects.length > 0 && (
      <div className={styles.pendingPanel}>
        <h2 className={styles.pendingTitle}>Pending project access</h2>
        <div className={styles.pendingChips}>
          {pendingProjects.map((project) => (
            <span key={project} className={styles.pendingChip}>{project}</span>
          ))}
        </div>
      </div>
    )}
    {afterGrid}
  </>
);

interface ProjectResultsProps {
  isLoading: boolean;
  isError: boolean;
  projects: AdoProject[];
  selectedProject: string;
  onSelect: (project: string) => void;
  emptyLabel: string;
}

const ProjectResults: React.FC<ProjectResultsProps> = ({
  isLoading,
  isError,
  projects,
  selectedProject,
  onSelect,
  emptyLabel,
}) => {
  if (isLoading) {
    return (
      <div className={styles.loadingState}>
        <div className={styles.spinner} />
        <span>Loading projects…</span>
      </div>
    );
  }

  if (isError) {
    return <p className={styles.errorMsg}>Could not load projects. Check your project catalog connection.</p>;
  }

  if (projects.length === 0) {
    return <p className={styles.emptyText}>{emptyLabel}</p>;
  }

  return (
    <div className={styles.projectList} {...{ 'data-testid': 'project-selector-grid' }}>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          className={`${styles.projectRow} ${project.name === selectedProject ? styles.projectRowSelected : ''}`}
          onClick={() => onSelect(project.name)}
          {...{ 'data-testid': `project-selector-card-${project.id}` }}
        >
          <span className={styles.projectCopy}>
            <span className={styles.projectName}>{project.name}</span>
            {project.description && <span className={styles.projectMeta}>{project.description}</span>}
          </span>
          <span className={styles.rowAction}>Open</span>
        </button>
      ))}
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
