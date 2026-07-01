import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { DueDateReasonModal } from './components/DueDateReasonModal';
import { BetaAnnouncementModal } from './components/BetaAnnouncementModal';
import { Changelog } from './components/Changelog';
import { Login } from './components/Login';
import { ViewErrorFallback } from './components/ViewErrorFallback';
import { ViewSkeleton } from './components/ViewSkeleton';
import { AppHeader } from './components/AppHeader';
import { PlanningTabs, type PlanningTab } from './components/PlanningTabs';
import { ProjectSelector } from './components/ProjectSelector';
import { AgentHome } from './components/AgentHome';
import { ChatAgentPanel } from './components/ChatAgentPanel';
import { NotificationProvider } from './contexts/NotificationContext';
import { ToastContainer } from './components/ToastContainer';
import { useAppShell } from './hooks/useAppShell';
import { useProjectMenuConfig } from './hooks/useProjectMenuConfig';
import { useProjectRepoConfigs } from './hooks/useProjectRepoConfigs';
import { useProjectSkillConfig } from './hooks/useProjectSkillConfig';
import { useChatThread, useSkillRepos, useStartChat } from './hooks/useChatThreads';
import { RepoSelector } from './components/RepoSelector';
import { DEFAULT_MODEL_ID } from './config/models';
import { FeatureFlagDemo } from './components/FeatureFlagDemo';
import { useFeatureFlag } from './hooks/useFeatureFlags';
import { IS_BETA_RELEASE } from './config/release';
import './App.css';

// Lazy-loaded views for code splitting
const ScrumCalendar = lazy(() => import('./components/ScrumCalendar').then(m => ({ default: m.ScrumCalendar })));
const UnscheduledList = lazy(() => import('./components/UnscheduledList').then(m => ({ default: m.UnscheduledList })));
const DetailsPanel = lazy(() => import('./components/DetailsPanel').then(m => ({ default: m.DetailsPanel })));
const CycleTimeAnalytics = lazy(() => import('./components/CycleTimeAnalytics').then(m => ({ default: m.CycleTimeAnalytics })));
const DevStats = lazy(() => import('./components/DevStats').then(m => ({ default: m.DevStats })));
const QAMetrics = lazy(() => import('./components/QAMetrics').then(m => ({ default: m.QAMetrics })));
const RoadmapView = lazy(() => import('./components/RoadmapView').then(m => ({ default: m.RoadmapView })));
const ReleaseView = lazy(() => import('./components/ReleaseView'));
const CloudCost = lazy(() => import('./components/CloudCost').then(m => ({ default: m.CloudCost })));
const AIAnalysis = lazy(() => import('./components/AIAnalysis').then(m => ({ default: m.AIAnalysis })));
const InterviewsDashboard = lazy(() => import('./components/InterviewsDashboard'));
const InterviewChatView = lazy(() => import('./components/InterviewChatView'));
const PrdReviewView = lazy(() => import('./components/PrdReviewView'));
const DesignDocReviewView = lazy(() => import('./components/DesignDocReviewView'));
const DesignPrototypeReviewView = lazy(() => import('./components/DesignPrototypeReviewView'));
const DesignPlanReviewView = lazy(() => import('./components/DesignPlanReviewView'));
const AdminRoles = lazy(() => import('./components/AdminRoles').then(m => ({ default: m.AdminRoles })));
const AdminUsers = lazy(() => import('./components/AdminUsers').then(m => ({ default: m.AdminUsers })));
const AdminProjectSettings = lazy(() => import('./components/AdminProjectSettings').then(m => ({ default: m.AdminProjectSettings })));
const AdminGroups = lazy(() => import('./components/AdminGroups').then(m => ({ default: m.AdminGroups })));
const AdminNotifications = lazy(() => import('./components/AdminNotifications').then(m => ({ default: m.AdminNotifications })));
const PlatformAdmin = lazy(() => import('./components/PlatformAdmin').then(m => ({ default: m.PlatformAdmin })));
const NotificationsPage = lazy(() => import('./components/NotificationsPage').then(m => ({ default: m.NotificationsPage })));
const DevWorkbenchView = lazy(() => import('./components/DevWorkbenchView').then(m => ({ default: m.DevWorkbenchView })));
const DevSessionView = lazy(() => import('./components/DevSessionView').then(m => ({ default: m.DevSessionView })));
const StandupCeremonyView = lazy(() => import('./components/StandupCeremonyView'));
const StandupManageView = lazy(() => import('./components/StandupManageView'));
const StandupSummaryView = lazy(() => import('./components/StandupSummaryView'));

const PLANNING_TABS: readonly PlanningTab[] = ['cycle-time', 'dev-stats', 'qa', 'ai-analysis', 'roadmap', 'releases'];

/** Tabs visible in the tab bar, in display order — used for permission-aware default/fallback. */
const VISIBLE_PLANNING_TABS: readonly PlanningTab[] = ['dev-stats', 'qa', 'ai-analysis', 'roadmap', 'releases'];

const PLANNING_TAB_PERMISSIONS: Record<PlanningTab, string> = {
  'cycle-time':  'planning:view',
  'dev-stats':   'planning:devstats',
  'qa':          'planning:qa',
  'ai-analysis': 'planning:ai-analysis',
  'roadmap':     'planning:roadmap',
  'releases':    'planning:releases',
};

const isPlanningTab = (value: string | undefined): value is PlanningTab => (
  value !== undefined && PLANNING_TABS.includes(value as PlanningTab)
);

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [chatOpen, setChatOpen] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [pendingProject, setPendingProject] = useState<string | null>(null);
  const { data: activeThread = null } = useChatThread(activeThreadId);

  type CurrentView = 'project-selector' | 'platform-admin' | 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'notifications' | 'admin' | 'my-work' | 'standup' | 'standup-manage' | 'standup-summary';
  const currentView: CurrentView =
    location.pathname === '/'
      ? 'project-selector'
      : location.pathname === '/platform-admin'
        ? 'platform-admin'
        : location.pathname === '/home'
          ? 'home'
          : location.pathname === '/calendar'
            ? 'calendar'
            : location.pathname.startsWith('/planning')
              ? 'planning'
              : location.pathname === '/cloud-cost'
                ? 'cloudcost'
                : location.pathname.startsWith('/backlog')
                  ? 'backlog'
                  : location.pathname === '/notifications'
                    ? 'notifications'
                    : location.pathname.startsWith('/admin')
                    ? 'admin'
                    : location.pathname.startsWith('/my-work')
                    ? 'my-work'
                    : location.pathname === '/standup-manage'
                    ? 'standup-manage'
                    : location.pathname === '/standup-summary'
                    ? 'standup-summary'
                    : location.pathname === '/standup'
                    ? 'standup'
                    : 'calendar';

  const planningTabSegment = location.pathname.startsWith('/planning')
    ? location.pathname.split('/')[2]
    : undefined;

  // Close the slide-out panel when landing on the home view — the full-page
  // AgentHome already provides the complete chat experience there.
  useEffect(() => {
    if (currentView === 'home') {
      setChatOpen(false);
    }
  }, [currentView]);

  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) return;
    favicon.href = IS_BETA_RELEASE ? '/favicon-beta.svg' : '/favicon.svg';
  }, []);

  const {
    isAuthenticated,
    authenticatedUser,
    can,
    isInAnyGroup,
    isSuperAdmin,
    permissionsLoaded,
    workItems,
    error,
    isLoading,
    isSaving,
    selectedItem,
    setSelectedItem,
    theme,
    setThemeMode,
    showChangelog,
    setShowChangelog,
    hasUnreadChangelog,
    showChangelogOnLogin,
    handleMarkChangelogAsRead,
    handleToggleShowChangelogOnLogin,
    handleLogout,
    selectedProject,
    selectedAreaPath,
    availableProjects,
    changeProject,
    changeAreaPath,
    selectedSkillSettingsId,
    changeSkillSettings,
    scheduledItems,
    unscheduledItems,
    pendingDueDateChange,
    handleDueDateChange,
    handleConfirmDueDateChange,
    handleCancelDueDateChange,
    handleFieldUpdate,
    betaAnnouncementDismissed,
    handleDismissBetaAnnouncement,
  } = useAppShell();

  const showBetaAnnouncement = useFeatureFlag('beta-to-prod-announcement', selectedProject);

  const planningTab: PlanningTab = isPlanningTab(planningTabSegment) ? planningTabSegment
    : (VISIBLE_PLANNING_TABS.find((t) => can(PLANNING_TAB_PERMISSIONS[t])) ?? VISIBLE_PLANNING_TABS[0]);

  const { enabledViews } = useProjectMenuConfig(selectedProject);

  // On the project picker, only fetch repo configs once a project is clicked (pending).
  // Elsewhere (header repo switcher), load configs for the active project.
  const repoConfigProject = currentView === 'project-selector' ? pendingProject : selectedProject;
  const {
    data: repoConfigs = [],
    isFetched: repoConfigsFetched,
    isError: repoConfigsError,
  } = useProjectRepoConfigs(repoConfigProject);
  const { data: activeSkillConfig } = useProjectSkillConfig(selectedProject || null, selectedSkillSettingsId);

  useEffect(() => {
    if (!pendingProject || !repoConfigsFetched) return;
    const project = pendingProject;
    const completePendingSelect = (settingsId: string | null) => {
      changeProject(project);
      changeAreaPath(project);
      changeSkillSettings(settingsId);
      setPendingProject(null);
      navigate('/home');
      fetch(`/api/projects/${encodeURIComponent(project)}/select`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {});
    };
    // Degrade gracefully when skill-configs is unavailable (e.g. migration not applied yet).
    if (repoConfigsError || repoConfigs.length === 0) {
      completePendingSelect(null);
    } else if (repoConfigs.length === 1) {
      completePendingSelect(repoConfigs[0].id);
    }
    // >1 configs: handled by RepoSelector render branch
  }, [pendingProject, repoConfigs, repoConfigsFetched, repoConfigsError, changeProject, changeAreaPath, changeSkillSettings, navigate]);

  // Guard all gated routes: redirect if the user lacks the required permission.
  // Wait for permissionsLoaded to avoid redirecting before the permissions fetch completes.
  useEffect(() => {
    if (!permissionsLoaded) return;
    if (currentView === 'platform-admin' && !isSuperAdmin) navigate('/');
    if (currentView === 'admin'         && !can('admin:roles'))   navigate('/home');
    if (currentView === 'calendar'      && !isSuperAdmin && (!enabledViews.includes('calendar')  || !can('calendar:view')))  navigate('/home');
    if (currentView === 'cloudcost'     && !isSuperAdmin && (!enabledViews.includes('cloudcost') || !can('cost:view')))      navigate('/home');
    if (currentView === 'backlog'       && !isSuperAdmin && (!enabledViews.includes('backlog')   || !can('interviews:view'))) navigate('/home');
    if (currentView === 'notifications' && !can('notifications:view'))  navigate('/home');
    if (currentView === 'my-work'       && !isSuperAdmin && (!enabledViews.includes('my-work') || !can('dev-workbench:view'))) navigate('/home');
    if (currentView === 'standup'        && !isSuperAdmin && (!enabledViews.includes('standup') || !can('standup:participate'))) navigate('/home');
    if (currentView === 'standup-manage' && !isSuperAdmin && (!enabledViews.includes('standup') || !can('standup:manage')))      navigate('/home');
    if (currentView === 'standup-summary' && !isSuperAdmin && (!enabledViews.includes('standup') || !can('standup:participate'))) navigate('/home');
    if (currentView === 'planning') {
      if (!isSuperAdmin && (!enabledViews.includes('planning') || !can('planning:view'))) {
        navigate('/home');
      } else if (!isSuperAdmin && !can(PLANNING_TAB_PERMISSIONS[planningTab])) {
        const firstAccessible = VISIBLE_PLANNING_TABS.find((t) => can(PLANNING_TAB_PERMISSIONS[t]));
        navigate(firstAccessible ? `/planning/${firstAccessible}` : '/home');
      }
    }
  }, [currentView, planningTab, permissionsLoaded, can, isSuperAdmin, enabledViews, navigate]);


  const { data: skillRepos = [], isLoading: isLoadingSkillRepos } = useSkillRepos(selectedProject || null);
  const startChat = useStartChat();
  const panelRepo = activeSkillConfig
    ? { name: activeSkillConfig.skillRepo, defaultBranch: activeSkillConfig.skillBranch }
    : (skillRepos.find((repo) => repo.name.toLowerCase() === selectedProject.toLowerCase()) ?? skillRepos[0]);

  const handleStartPanelChat = useCallback(async () => {
    if (!can('chat:view')) return;
    setChatOpen(true);
    if (!panelRepo || startChat.isPending) return;
    setActiveThreadId(null);
    try {
      const result = await startChat.mutateAsync({
        kickoff: {
          project: selectedProject,
          repo: panelRepo.name,
          branch: panelRepo.defaultBranch ?? 'main',
          model: DEFAULT_MODEL_ID,
          skillSettingsId: selectedSkillSettingsId ?? undefined,
        },
      });
      setActiveThreadId(result.threadId);
    } catch {
      // Error shown inside the panel
    }
  }, [panelRepo, selectedProject, startChat, selectedSkillSettingsId]);

  if (isAuthenticated === null) return <div>Loading...</div>;
  if (!isAuthenticated) return <Login />;

  if (currentView === 'project-selector') {
    const showRepoSelector = Boolean(
      pendingProject && repoConfigsFetched && !repoConfigsError && repoConfigs.length > 1,
    );
    const pendingSelectInProgress = Boolean(pendingProject && !showRepoSelector);

    if (showRepoSelector) {
      return (
        <ErrorBoundary FallbackComponent={ViewErrorFallback}>
          <RepoSelector
            configs={repoConfigs}
            onSelect={(settingsId) => {
              const project = pendingProject;
              if (!project) return;
              changeProject(project);
              changeAreaPath(project);
              changeSkillSettings(settingsId);
              setPendingProject(null);
              navigate('/home');
              fetch(`/api/projects/${encodeURIComponent(project)}/select`, {
                method: 'POST',
                credentials: 'include',
              }).catch(() => {});
            }}
            onBack={() => setPendingProject(null)}
          />
        </ErrorBoundary>
      );
    }

    if (pendingSelectInProgress) {
      return (
        <div className="loading-overlay">
          <div className="loading-spinner-container">
            <div className="spinner" />
            <p>Opening project…</p>
          </div>
        </div>
      );
    }

    return (
      <ErrorBoundary FallbackComponent={ViewErrorFallback}>
        <ProjectSelector
          selectedProject={selectedProject}
          onSelect={(project) => {
            setPendingProject(project);
          }}
          isSuperAdmin={isSuperAdmin}
          onOpenPlatformAdmin={() => navigate('/platform-admin')}
          hasUnreadChangelog={hasUnreadChangelog}
          showChangelogOnLogin={showChangelogOnLogin}
          showChangelog={showChangelog}
          onSetShowChangelog={setShowChangelog}
          onMarkChangelogAsRead={handleMarkChangelogAsRead}
          onToggleShowChangelogOnLogin={handleToggleShowChangelogOnLogin}
          user={authenticatedUser}
          theme={theme}
          onThemeChange={setThemeMode}
          onLogout={handleLogout}
        />
        <Changelog
          isOpen={showChangelog}
          onClose={() => setShowChangelog(false)}
          onMarkAsRead={handleMarkChangelogAsRead}
          showOnLogin={showChangelogOnLogin}
          onToggleShowOnLogin={handleToggleShowChangelogOnLogin}
        />
      </ErrorBoundary>
    );
  }

  if (currentView === 'platform-admin') {
    if (!permissionsLoaded || !isSuperAdmin) return null;
    return (
      <ErrorBoundary FallbackComponent={ViewErrorFallback}>
        <Suspense fallback={<ViewSkeleton />}>
          <PlatformAdmin
            onBackToProjects={() => navigate('/')}
            user={authenticatedUser}
            theme={theme}
            hasUnreadChangelog={hasUnreadChangelog}
            onThemeChange={setThemeMode}
            onOpenChangelog={() => setShowChangelog(true)}
            onLogout={handleLogout}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
      <DndProvider backend={HTML5Backend}>
      <NotificationWrapper can={can}>
        <div className="app">
          {isLoading && currentView === 'calendar' && (
            <div className="loading-overlay">
              <div className="loading-spinner-container">
                <div className="spinner"></div>
                <p>Loading work items...</p>
              </div>
            </div>
          )}
          {isSaving && (
            <div className="saving-indicator">
              <div className="saving-content">
                <div className="saving-spinner"></div>
                <span>Saving...</span>
              </div>
            </div>
          )}
          <AppHeader
            currentView={currentView as 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'admin' | 'my-work' | 'standup' | 'standup-manage' | 'standup-summary'}
            planningTab={planningTab}
            theme={theme}
            user={authenticatedUser}
            hasUnreadChangelog={hasUnreadChangelog}
            can={can}
            isInAnyGroup={isInAnyGroup}
            menuEnabledViews={enabledViews}
            isSuperAdmin={isSuperAdmin}
            repoConfigs={repoConfigs}
            selectedSkillSettingsId={selectedSkillSettingsId}
            onChangeSkillSettings={changeSkillSettings}
            onNavigateHome={() => navigate('/home')}
            onNavigateProjects={() => navigate('/')}
            onNavigateCalendar={() => navigate('/calendar')}
            onNavigatePlanning={() => navigate(`/planning/${planningTab}`)}
            onNavigateCloudCost={() => navigate('/cloud-cost')}
            onNavigateBacklog={() => navigate('/backlog')}
            onNavigateMyWork={() => navigate('/my-work')}
            onNavigateStandup={() => navigate('/standup')}
            onNavigateAdmin={() => navigate('/admin/roles')}
            onOpenChangelog={() => setShowChangelog(true)}
            onThemeChange={setThemeMode}
            onLogout={handleLogout}
            onOpenAgentChat={currentView !== 'home' ? () => setChatOpen(true) : undefined}
          />
          {error && <div className="error-banner">{error}</div>}

          {currentView === 'home' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              {/* Top-level split: demo component gated by "example-flag-demo" flag */}
              <FeatureFlagDemo project={selectedProject} />
              <AgentHome selectedProject={selectedProject} selectedSkillSettingsId={selectedSkillSettingsId} />
            </ErrorBoundary>
          ) : currentView === 'calendar' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                {!isLoading && (
                  <div className="calendar-view">
                    <UnscheduledList
                      workItems={unscheduledItems}
                      allWorkItems={workItems}
                      onSelectItem={setSelectedItem}
                      onUpdateDueDate={(id, dueDate) => {
                        setSelectedItem(null);
                        handleDueDateChange(id, dueDate);
                      }}
                    />
                    <ScrumCalendar
                      workItems={scheduledItems}
                      unscheduledItems={unscheduledItems}
                      onUpdateDueDate={(id, dueDate) => {
                        setSelectedItem(null);
                        handleDueDateChange(id, dueDate);
                      }}
                      onUpdateField={handleFieldUpdate}
                      onSelectItem={setSelectedItem}
                    />
                    {selectedItem && (
                      <DetailsPanel
                        workItem={selectedItem}
                        onClose={() => setSelectedItem(null)}
                        onUpdateDueDate={handleDueDateChange}
                        allWorkItems={workItems}
                        onUpdateField={handleFieldUpdate}
                        isSaving={isSaving}
                        project={selectedProject}
                        areaPath={selectedAreaPath}
                        onSelectItem={setSelectedItem}
                      />
                    )}
                    {pendingDueDateChange && (
                      <DueDateReasonModal
                        workItemId={pendingDueDateChange.workItemId}
                        workItemTitle={pendingDueDateChange.workItemTitle}
                        oldDueDate={pendingDueDateChange.oldDueDate}
                        newDueDate={pendingDueDateChange.newDueDate}
                        onConfirm={handleConfirmDueDateChange}
                        onCancel={handleCancelDueDateChange}
                      />
                    )}
                  </div>
                )}
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'cloudcost' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="cloudcost-view">
                  <CloudCost project={selectedProject} areaPath={selectedAreaPath} />
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'backlog' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="backlog-view">
                  {location.pathname.startsWith('/backlog/interview/') ? (
                    <InterviewChatView />
                  ) : location.pathname.startsWith('/backlog/prd/') ? (
                    <PrdReviewView />
                  ) : location.pathname.startsWith('/backlog/design-prototypes/') ? (
                    <DesignPrototypeReviewView />
                  ) : location.pathname.startsWith('/backlog/design-plan/') ? (
                    <DesignPlanReviewView />
                  ) : location.pathname.startsWith('/backlog/design-doc/') ? (
                    <DesignDocReviewView />
                  ) : (
                    <InterviewsDashboard />
                  )}
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'notifications' && can('notifications:view') ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <NotificationsPage />
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'admin' && can('admin:roles') ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="admin-container">
                  <div className="admin-tabs">
                    <button
                      className={`admin-tab${location.pathname.startsWith('/admin/roles') || location.pathname === '/admin' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/roles')}
                      type="button"
                    >
                      Roles
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/users' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/users')}
                      type="button"
                    >
                      Users
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/groups' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/groups')}
                      type="button"
                    >
                      Groups
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/project-settings' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/project-settings')}
                      type="button"
                    >
                      Project Settings
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/notifications' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/notifications')}
                      type="button"
                    >
                      Notifications
                    </button>
                  </div>
                  {location.pathname === '/admin/users' ? (
                    <AdminUsers />
                  ) : location.pathname === '/admin/groups' ? (
                    <AdminGroups selectedProject={selectedProject} availableProjects={availableProjects} />
                  ) : location.pathname === '/admin/project-settings' ? (
                    <AdminProjectSettings selectedProject={selectedProject} availableProjects={availableProjects} />
                  ) : location.pathname === '/admin/notifications' ? (
                    <AdminNotifications />
                  ) : (
                    <AdminRoles />
                  )}
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'my-work' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="my-work-view">
                  {location.pathname.startsWith('/my-work/session/') ? (
                    <DevSessionView />
                  ) : (
                    <DevWorkbenchView />
                  )}
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'standup' && can('standup:participate') ? (
            <div className="standup-view">
              <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                <Suspense fallback={<ViewSkeleton />}>
                  <StandupCeremonyView />
                </Suspense>
              </ErrorBoundary>
            </div>
          ) : currentView === 'standup-manage' && can('standup:manage') ? (
            <div className="standup-view">
              <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                <Suspense fallback={<ViewSkeleton />}>
                  <StandupManageView />
                </Suspense>
              </ErrorBoundary>
            </div>
          ) : currentView === 'standup-summary' && can('standup:participate') ? (
            <div className="standup-view">
              <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                <Suspense fallback={<ViewSkeleton />}>
                  <StandupSummaryView />
                </Suspense>
              </ErrorBoundary>
            </div>
          ) : currentView === 'planning' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <div className="planning-view">
                <PlanningTabs
                  activeTab={planningTab}
                  can={can}
                  onNavigate={(tab) => navigate(`/planning/${tab}`)}
                />
                <div className="planning-content">
                  {planningTab === 'cycle-time' ? (
                    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                      <Suspense fallback={<ViewSkeleton />}>
                        <CycleTimeAnalytics workItems={workItems} project={selectedProject} areaPath={selectedAreaPath} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : planningTab === 'dev-stats' ? (
                    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                      <Suspense fallback={<ViewSkeleton />}>
                        <DevStats workItems={workItems} project={selectedProject} areaPath={selectedAreaPath} onSelectItem={setSelectedItem} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : planningTab === 'qa' ? (
                    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                      <Suspense fallback={<ViewSkeleton />}>
                        <QAMetrics workItems={workItems} project={selectedProject} areaPath={selectedAreaPath} onSelectItem={setSelectedItem} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : planningTab === 'ai-analysis' ? (
                    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                      <Suspense fallback={<ViewSkeleton />}>
                        <AIAnalysis workItems={workItems} project={selectedProject} areaPath={selectedAreaPath} onSelectItem={setSelectedItem} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : planningTab === 'roadmap' ? (
                    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                      <Suspense fallback={<ViewSkeleton />}>
                        <RoadmapView workItems={workItems} project={selectedProject} areaPath={selectedAreaPath} onSelectItem={setSelectedItem} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : planningTab === 'releases' ? (
                    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
                      <Suspense fallback={<ViewSkeleton />}>
                        <ReleaseView workItems={workItems} project={selectedProject} areaPath={selectedAreaPath} onSelectItem={setSelectedItem} />
                      </Suspense>
                    </ErrorBoundary>
                  ) : null}
                </div>
                {selectedItem && currentView === 'planning' && (
                  <Suspense fallback={null}>
                    <DetailsPanel
                      workItem={selectedItem}
                      onClose={() => setSelectedItem(null)}
                      onUpdateDueDate={handleDueDateChange}
                      allWorkItems={workItems}
                      onUpdateField={handleFieldUpdate}
                      isSaving={isSaving}
                      project={selectedProject}
                      areaPath={selectedAreaPath}
                      onSelectItem={setSelectedItem}
                    />
                  </Suspense>
                )}
              </div>
            </ErrorBoundary>
          ) : null}
        </div>
        <Changelog
          isOpen={showChangelog}
          onClose={() => setShowChangelog(false)}
          onMarkAsRead={handleMarkChangelogAsRead}
          showOnLogin={showChangelogOnLogin}
          onToggleShowOnLogin={handleToggleShowChangelogOnLogin}
        />
        {showBetaAnnouncement && !(isSuperAdmin && betaAnnouncementDismissed) && (
          <BetaAnnouncementModal
            isSuperAdmin={isSuperAdmin}
            onDismiss={handleDismissBetaAnnouncement}
          />
        )}

        <ChatAgentPanel
          thread={activeThread}
          isOpen={chatOpen}
          onClose={() => setChatOpen(false)}
          onNewChat={handleStartPanelChat}
          onSelectThread={(id) => setActiveThreadId(id || null)}
          selectedProject={selectedProject}
          canStartNewChat={!!panelRepo && !isLoadingSkillRepos && !startChat.isPending}
          isStartingNewChat={startChat.isPending}
          newChatError={startChat.error?.message}
        />
      </NotificationWrapper>
      </DndProvider>
    </ErrorBoundary>
  );
}

interface NotificationWrapperProps {
  can: (key: string) => boolean;
  children: React.ReactNode;
}

const NotificationWrapper: React.FC<NotificationWrapperProps> = ({ can, children }) => {
  if (!can('notifications:view')) return <>{children}</>;
  return (
    <NotificationProvider>
      {children}
      <ToastContainer />
    </NotificationProvider>
  );
};

export default App;
