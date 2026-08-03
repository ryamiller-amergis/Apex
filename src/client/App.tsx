import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { DueDateReasonModal } from './components/DueDateReasonModal';
import { BetaAnnouncementModal } from './components/BetaAnnouncementModal';
import { Changelog } from './components/Changelog';
import { GuidedWalkthroughHost } from './components/GuidedWalkthroughHost';
import { WhatsNewBanner } from './components/WhatsNewBanner';
import { Login } from './components/Login';
import { ViewErrorFallback } from './components/ViewErrorFallback';
import { ViewSkeleton } from './components/ViewSkeleton';
import { AppHeader } from './components/AppHeader';
import { AppSidebar } from './components/AppSidebar';
import { PlanningTabs, type PlanningTab } from './components/PlanningTabs';
import { ApexLoader } from './components/ApexLoader';
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
import { PdfToolsRouteGuard } from './components/PdfToolsRouteGuard';
import { DesktopOnlyGate } from './components/DesktopOnlyGate';
import { useFeatureFlag, useFeatureFlags } from './hooks/useFeatureFlags';
import { resolveAccessibleRoute } from './utils/accessibleRoute';
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
const AiCostAnalytics = lazy(() => import('./components/AiCostAnalytics').then(m => ({ default: m.AiCostAnalytics })));
const InterviewsDashboard = lazy(() => import('./components/InterviewsDashboard'));
const InterviewChatView = lazy(() => import('./components/InterviewChatView'));
const AdrsDashboard = lazy(() => import('./components/AdrsDashboard'));
const AdrChatView = lazy(() => import('./components/AdrChatView'));
const PrdReviewView = lazy(() => import('./components/PrdReviewView'));
const DesignDocReviewView = lazy(() => import('./components/DesignDocReviewView'));
const DesignPrototypeReviewView = lazy(() => import('./components/DesignPrototypeReviewView'));
const DesignPlanReviewView = lazy(() => import('./components/DesignPlanReviewView'));
const AdminRoles = lazy(() => import('./components/AdminRoles').then(m => ({ default: m.AdminRoles })));
const AdminUsers = lazy(() => import('./components/AdminUsers').then(m => ({ default: m.AdminUsers })));
const AdminProjectSettings = lazy(() => import('./components/AdminProjectSettings').then(m => ({ default: m.AdminProjectSettings })));
const AdminGroups = lazy(() => import('./components/AdminGroups').then(m => ({ default: m.AdminGroups })));
const AdminNotifications = lazy(() => import('./components/AdminNotifications').then(m => ({ default: m.AdminNotifications })));
const LoadTestAllowlistSettings = lazy(() => import('./components/LoadTestAllowlistSettings').then(m => ({ default: m.LoadTestAllowlistSettings })));
const PlatformAdmin = lazy(() => import('./components/PlatformAdmin').then(m => ({ default: m.PlatformAdmin })));
const NotificationsPage = lazy(() => import('./components/NotificationsPage').then(m => ({ default: m.NotificationsPage })));
const ProfilePage = lazy(() => import('./components/ProfilePage').then(m => ({ default: m.ProfilePage })));
const DevWorkbenchView = lazy(() => import('./components/DevWorkbenchView').then(m => ({ default: m.DevWorkbenchView })));
const DevSessionView = lazy(() => import('./components/DevSessionView').then(m => ({ default: m.DevSessionView })));
const StandupCeremonyView = lazy(() => import('./components/StandupCeremonyView'));
const StandupManageView = lazy(() => import('./components/StandupManageView'));
const StandupSummaryView = lazy(() => import('./components/StandupSummaryView'));
const FeatureRequestsView = lazy(() => import('./components/FeatureRequestsView'));
const UiLabView = lazy(() => import('./components/UiLabView').then(m => ({ default: m.UiLabView })));
const PdfAssemblyView = lazy(() => import('./components/PdfAssemblyView').then(m => ({ default: m.PdfAssemblyView })));
const ApryseWebViewerPoc = lazy(() => import('./components/ApryseWebViewerPoc').then(m => ({ default: m.ApryseWebViewerPoc })));
const NutrientWebSdkPoc = lazy(() => import('./components/NutrientWebSdkPoc').then(m => ({ default: m.NutrientWebSdkPoc })));
const DesignModuleView = lazy(() => import('./components/DesignModuleView'));
const LoadTestsListPage = lazy(() => import('./components/LoadTestsListPage').then(m => ({ default: m.LoadTestsListPage })));
const LoadTestDefinitionBuilderView = lazy(() =>
  import('./components/LoadTestDefinitionBuilderView').then((m) => ({ default: m.LoadTestDefinitionBuilderView })),
);
const LoadTestRunDetailView = lazy(() =>
  import('./components/LoadTestRunDetailView').then((m) => ({ default: m.LoadTestRunDetailView })),
);
const LoadTestsRouteGuard = lazy(() =>
  import('./components/LoadTestsRouteGuard').then((m) => ({ default: m.LoadTestsRouteGuard })),
);
const CalendarWorkItemAssistantPanel = lazy(() => import('./components/CalendarWorkItemAssistantPanel').then(m => ({ default: m.CalendarWorkItemAssistantPanel })));

const PLANNING_TABS: readonly PlanningTab[] = ['cycle-time', 'dev-stats', 'qa', 'ai-analysis', 'roadmap', 'releases'];

/** Tabs visible in the tab bar, in display order — used for permission-aware default/fallback. */
const VISIBLE_PLANNING_TABS: readonly PlanningTab[] = ['dev-stats', 'qa', 'ai-analysis', 'roadmap', 'releases'];

// data-testid-exempt — TypeScript Record<PlanningTab, …> generic, not JSX
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
  const [calendarAssistantOpen, setCalendarAssistantOpen] = useState(false);
  const [calendarAssistantAnchor, setCalendarAssistantAnchor] = useState<{
    id: number;
    title: string;
  } | null>(null);

  const handleOpenCalendarAssistant = useCallback((anchorId: number, anchorTitle: string) => {
    // Close the global chat panel to avoid two competing drawers
    setChatOpen(false);
    setCalendarAssistantAnchor({ id: anchorId, title: anchorTitle });
    setCalendarAssistantOpen(true);
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('apex-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('apex-sidebar-collapsed', String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);
  const { data: activeThread = null } = useChatThread(activeThreadId);

  type CurrentView = 'project-selector' | 'platform-admin' | 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'adr' | 'notifications' | 'profile' | 'admin' | 'my-work' | 'standup' | 'standup-manage' | 'standup-summary' | 'feature-requests' | 'ui-lab' | 'pdf-tools' | 'ai-cost' | 'design-module' | 'load-tests' | 'not-found';
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
                  : location.pathname.startsWith('/adr')
                    ? 'adr'
                  : location.pathname === '/notifications'
                    ? 'notifications'
                    : location.pathname === '/profile'
                    ? 'profile'
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
                    : location.pathname === '/feature-requests'
                    ? 'feature-requests'
                    : location.pathname.startsWith('/ui-lab')
                    ? 'ui-lab'
                    : location.pathname.startsWith('/pdf-tools')
                    ? 'pdf-tools'
                    : location.pathname === '/ai-cost'
                    ? 'ai-cost'
                    : location.pathname === '/design-module'
                    ? 'design-module'
                    : location.pathname.startsWith('/load-tests')
                    ? 'load-tests'
                    : 'not-found';

  const planningTabSegment = location.pathname.startsWith('/planning')
    ? location.pathname.split('/')[2]
    : undefined;

  // Close the slide-out panel when landing on the home view — the full-page
  // AgentHome already provides the complete chat experience there.
  // Adjust during render (same pattern as AppHeader) to avoid set-state-in-effect.
  if (currentView === 'home' && chatOpen) {
    setChatOpen(false);
  }

  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) return;
    favicon.href = IS_BETA_RELEASE ? '/favicon-beta.svg' : '/favicon.svg';
  }, []);

  const needsWorkItems = currentView === 'calendar' || currentView === 'planning';

  const {
    isAuthenticated,
    authenticatedUser,
    can,
    isInAnyGroup,
    userId,
    isSuperAdmin,
    permissionsLoaded,
    workItems,
    error,
    isFetchingWorkItems,
    refetchWorkItems,
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
    handleDismissWhatsNewBanner,
    handleToggleShowChangelogOnLogin,
    whatsNewLastSeenVersion,
    whatsNewManualUnavailable,
    whatsNewCurrentVersion,
    whatsNewAutomaticOverlaySettled,
    whatsNewBlocksAutomaticWalkthrough,
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
  } = useAppShell({ workItemsEnabled: needsWorkItems });

  const showBetaAnnouncement = useFeatureFlag('beta-to-prod-announcement', selectedProject);
  const { flags: homeFlags, isLoading: homeFlagsLoading } = useFeatureFlags(selectedProject);
  const agentHomeFlag = homeFlags['agent-home'] ?? false;

  const canAccessHome =
    !homeFlagsLoading && permissionsLoaded && agentHomeFlag && (isSuperAdmin || can('home:view'));

  const planningTab: PlanningTab = isPlanningTab(planningTabSegment) ? planningTabSegment
    : (VISIBLE_PLANNING_TABS.find((t) => can(PLANNING_TAB_PERMISSIONS[t])) ?? VISIBLE_PLANNING_TABS[0]);

  const { enabledViews, isLoading: menuConfigLoading } = useProjectMenuConfig(selectedProject);

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
      navigate(resolveAccessibleRoute({
        canAccessHome,
        can,
        isSuperAdmin,
        enabledViews,
        selectedProject: project,
        isInAnyGroup,
      }));
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
  }, [pendingProject, repoConfigs, repoConfigsFetched, repoConfigsError, changeProject, changeAreaPath, changeSkillSettings, navigate, canAccessHome, can, isSuperAdmin, enabledViews, isInAnyGroup]);

  // Guard all gated routes: redirect if the user lacks the required permission.
  // Wait for permissionsLoaded and homeFlagsLoading to avoid redirecting before
  // the permissions and flag fetches complete.
  useEffect(() => {
    if (!permissionsLoaded || menuConfigLoading || homeFlagsLoading) return;

    const fallback = resolveAccessibleRoute({
      canAccessHome,
      can,
      isSuperAdmin,
      enabledViews,
      selectedProject,
      isInAnyGroup,
    });

    if (currentView === 'platform-admin' && !isSuperAdmin) navigate('/');
    if (currentView === 'home'           && !canAccessHome) navigate(fallback);
    if (currentView === 'admin'         && !can('admin:roles'))   navigate(fallback);
    if (currentView === 'calendar'      && !isSuperAdmin && (!enabledViews.includes('calendar')  || !can('calendar:view')))  navigate(fallback);
    if (currentView === 'cloudcost'     && !isSuperAdmin && (!enabledViews.includes('cloudcost') || !can('cost:view')))      navigate(fallback);
    if (currentView === 'ai-cost'       && !isSuperAdmin && (!enabledViews.includes('ai-cost')    || !can('analytics:ai-cost:view'))) navigate(fallback);
    if (currentView === 'backlog'       && !isSuperAdmin && (!enabledViews.includes('backlog')   || !can('interviews:view'))) navigate(fallback);
    if (currentView === 'adr'           && !isSuperAdmin && (!enabledViews.includes('adr')       || !can('adr:view'))) navigate(fallback);
    if (currentView === 'notifications' && !can('notifications:view'))  navigate(fallback);
    if (currentView === 'my-work'       && !isSuperAdmin && (!enabledViews.includes('my-work') || !can('dev-workbench:view'))) navigate(fallback);
    if (currentView === 'standup'        && !isSuperAdmin && (!enabledViews.includes('standup') || !can('standup:participate'))) navigate(fallback);
    if (currentView === 'standup-manage' && !isSuperAdmin && (!enabledViews.includes('standup') || !can('standup:manage')))      navigate(fallback);
    if (currentView === 'standup-summary' && !isSuperAdmin && (!enabledViews.includes('standup') || !can('standup:participate'))) navigate(fallback);
    if (currentView === 'feature-requests' && !isSuperAdmin && (selectedProject !== 'Apex' || !enabledViews.includes('feature-requests') || !can('feature-requests:view'))) navigate(fallback);
    if (currentView === 'ui-lab'        && !isSuperAdmin && (!enabledViews.includes('ui-lab') || !can('ui-lab:view') || !isInAnyGroup(['UI/UX']))) navigate(fallback);
    if (currentView === 'pdf-tools'     && !isSuperAdmin && (!enabledViews.includes('pdf-tools') || !can('pdf-assembly:use'))) navigate(fallback);
    if (currentView === 'design-module' && !isSuperAdmin && (!enabledViews.includes('design-module') || !can('design-module:view'))) navigate(fallback);
    if (currentView === 'load-tests'    && !isSuperAdmin && (!enabledViews.includes('load-tests')    || !can('load-test:view')))    navigate(fallback);
    if (currentView === 'planning') {
      if (!isSuperAdmin && (!enabledViews.includes('planning') || !can('planning:view'))) {
        navigate(fallback);
      } else if (!isSuperAdmin && !can(PLANNING_TAB_PERMISSIONS[planningTab])) {
        const firstAccessible = VISIBLE_PLANNING_TABS.find((t) => can(PLANNING_TAB_PERMISSIONS[t]));
        navigate(firstAccessible ? `/planning/${firstAccessible}` : fallback);
      }
    }
  }, [currentView, planningTab, permissionsLoaded, menuConfigLoading, homeFlagsLoading, canAccessHome, can, isInAnyGroup, isSuperAdmin, enabledViews, selectedProject, navigate]);


  const { data: skillRepos = [], isLoading: isLoadingSkillRepos } = useSkillRepos(selectedProject || null);
  const startChat = useStartChat();
  const panelRepo = useMemo(
    () =>
      activeSkillConfig
        ? { name: activeSkillConfig.skillRepo, defaultBranch: activeSkillConfig.skillBranch }
        : (skillRepos.find((repo) => repo.name.toLowerCase() === selectedProject.toLowerCase()) ?? skillRepos[0]),
    [activeSkillConfig, skillRepos, selectedProject],
  );

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
          skillProvider: activeSkillConfig?.skillProvider ?? undefined,
          model: DEFAULT_MODEL_ID,
          skillSettingsId: selectedSkillSettingsId ?? undefined,
        },
      });
      setActiveThreadId(result.threadId);
    } catch {
      // Error shown inside the panel
    }
  }, [panelRepo, selectedProject, startChat, selectedSkillSettingsId, can, activeSkillConfig]);

  if (isAuthenticated === null) return <div className="app-loading"><ApexLoader size={80} /></div>;
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
              navigate(resolveAccessibleRoute({
                canAccessHome,
                can,
                isSuperAdmin,
                enabledViews,
                selectedProject: project,
                isInAnyGroup,
              }));
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
            <ApexLoader size={72} />
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
          onMarkChangelogAsRead={handleDismissWhatsNewBanner}
          onToggleShowChangelogOnLogin={handleToggleShowChangelogOnLogin}
          whatsNewCurrentVersion={whatsNewCurrentVersion}
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
          lastSeenVersion={whatsNewLastSeenVersion}
          manualUnavailable={whatsNewManualUnavailable}
        />
        <GuidedWalkthroughHost
          projectId={selectedProject}
          userId={userId}
          enabled={false}
          whatsNewSettled={whatsNewAutomaticOverlaySettled}
          whatsNewBlocksWalkthrough={whatsNewBlocksAutomaticWalkthrough}
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

  if (currentView === 'not-found') {
    return (
      <ErrorBoundary FallbackComponent={ViewErrorFallback}>
        <div role="status" aria-live="polite" {...{ 'data-testid': 'route-not-found' }}>
          <h1>Page not found</h1>
          <p>The requested Apex page does not exist.</p>
          <button type="button" onClick={() => navigate('/')} {...{ 'data-testid': 'route-not-found-home-btn' }}>Return to projects</button>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
      <DndProvider backend={HTML5Backend}>
      <NotificationWrapper can={can}>
        <div className="app">
          <AppSidebar
            currentView={currentView}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={handleToggleSidebar}
            can={can}
            isInAnyGroup={isInAnyGroup}
            menuEnabledViews={enabledViews}
            isSuperAdmin={isSuperAdmin}
            selectedProject={selectedProject}
            canAccessHome={canAccessHome}
            onNavigateHome={() => navigate('/home')}
            onNavigateCalendar={() => navigate('/calendar')}
            onNavigatePlanning={() => navigate(`/planning/${planningTab}`)}
            onNavigateCloudCost={() => navigate('/cloud-cost')}
            onNavigateBacklog={() => navigate('/backlog')}
            onNavigateAdr={() => navigate('/adr')}
            onNavigateMyWork={() => navigate('/my-work')}
            onNavigateStandup={() => navigate('/standup')}
            onNavigateUiLab={() => navigate('/ui-lab')}
            onNavigateFeatureRequests={() => navigate('/feature-requests')}
            onNavigatePdfTools={() => navigate('/pdf-tools')}
            onNavigateAiCost={() => navigate('/ai-cost')}
            onNavigateDesignModule={() => navigate('/design-module')}
            onNavigateLoadTests={() => navigate('/load-tests')}
            onNavigateAdmin={() => navigate('/admin/roles')}
          />
          <div className={`app-main ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'}`}>
          {isLoading && currentView === 'calendar' && (
            <div className="loading-overlay">
              <div className="loading-spinner-container">
                <ApexLoader size={72} />
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
            currentView={currentView}
            planningTab={planningTab}
            theme={theme}
            user={authenticatedUser}
            hasUnreadChangelog={hasUnreadChangelog}
            can={can}
            isInAnyGroup={isInAnyGroup}
            menuEnabledViews={enabledViews}
            isSuperAdmin={isSuperAdmin}
            selectedProject={selectedProject}
            canAccessHome={canAccessHome}
            repoConfigs={repoConfigs}
            selectedSkillSettingsId={selectedSkillSettingsId}
            onChangeSkillSettings={changeSkillSettings}
            onNavigateHome={() => navigate('/home')}
            onNavigateProjects={() => navigate('/')}
            onNavigateCalendar={() => navigate('/calendar')}
            onNavigatePlanning={() => navigate(`/planning/${planningTab}`)}
            onNavigateCloudCost={() => navigate('/cloud-cost')}
            onNavigateBacklog={() => navigate('/backlog')}
            onNavigateAdr={() => navigate('/adr')}
            onNavigateMyWork={() => navigate('/my-work')}
            onNavigateStandup={() => navigate('/standup')}
            onNavigateFeatureRequests={() => navigate('/feature-requests')}
            onNavigateUiLab={() => navigate('/ui-lab')}
            onNavigateAdmin={() => navigate('/admin/roles')}
            onNavigateAiCost={() => navigate('/ai-cost')}
            onNavigateDesignModule={() => navigate('/design-module')}
            onNavigateLoadTests={() => navigate('/load-tests')}
            onOpenChangelog={() => setShowChangelog(true)}
            onThemeChange={setThemeMode}
            onLogout={handleLogout}
            onOpenAgentChat={currentView !== 'home' ? () => setChatOpen(true) : undefined}
          />
          {hasUnreadChangelog && (
            <div className="changelog-banner-row">
              {/* data-testid-exempt — WhatsNewBanner owns whats-new-banner root id */}
              <WhatsNewBanner
                currentVersion={whatsNewCurrentVersion}
                onOpenChangelog={() => setShowChangelog(true)}
                onMarkAsRead={handleDismissWhatsNewBanner}
                onToggleShowOnLogin={handleToggleShowChangelogOnLogin}
              />
            </div>
          )}

          {currentView === 'home' && canAccessHome ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              {/* Top-level split: demo component gated by "example-flag-demo" flag */}
              <FeatureFlagDemo project={selectedProject} />
              <AgentHome selectedProject={selectedProject} selectedSkillSettingsId={selectedSkillSettingsId} />
            </ErrorBoundary>
          ) : currentView === 'home' ? (
            /* Access controls still loading — withhold content to avoid a flash */
            null
          ) : currentView === 'calendar' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                {error && !isLoading && (
                  <div className="work-items-inline-error" role="status" data-testid="work-items-inline-error">
                    <span>
                      Calendar work items couldn&apos;t be refreshed
                      {workItems.length > 0 ? ' — showing the last loaded data.' : '.'}
                    </span>
                    <button
                      type="button"
                      className="work-items-inline-error-retry"
                      onClick={() => { void refetchWorkItems(); }}
                      disabled={isFetchingWorkItems}
                      data-testid="work-items-retry"
                    >
                      {isFetchingWorkItems ? 'Retrying…' : 'Retry'}
                    </button>
                  </div>
                )}
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
                      // data-testid-exempt — DetailsPanel owns its panel chrome; no data-testid prop
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
                        onOpenAssistant={handleOpenCalendarAssistant}
                      />
                    )}
                    {calendarAssistantOpen && calendarAssistantAnchor && (
                      <Suspense fallback={null}>
                        {/* data-testid-exempt — assistant panel API has no data-testid prop */}
                        <CalendarWorkItemAssistantPanel
                          anchorWorkItemId={calendarAssistantAnchor.id}
                          anchorTitle={calendarAssistantAnchor.title}
                          project={selectedProject}
                          areaPath={selectedAreaPath}
                          open={calendarAssistantOpen}
                          onClose={() => setCalendarAssistantOpen(false)}
                        />
                      </Suspense>
                    )}
                    {pendingDueDateChange && (
                      // data-testid-exempt — DueDateReasonModal API has no data-testid prop
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
          ) : currentView === 'ai-cost' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <AiCostAnalytics project={selectedProject} />
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'adr' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                {location.pathname === '/adr' ? <AdrsDashboard /> : <AdrChatView />}
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
          ) : currentView === 'profile' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <ProfilePage theme={theme} onThemeChange={setThemeMode} />
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
                      {...{ 'data-testid': 'admin-tab-roles' }}
                    >
                      Roles
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/users' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/users')}
                      type="button"
                      {...{ 'data-testid': 'admin-tab-users' }}
                    >
                      Users
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/groups' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/groups')}
                      type="button"
                      {...{ 'data-testid': 'admin-tab-groups' }}
                    >
                      Groups
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/project-settings' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/project-settings')}
                      type="button"
                      {...{ 'data-testid': 'admin-tab-project-settings' }}
                    >
                      Project Settings
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/notifications' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/notifications')}
                      type="button"
                      {...{ 'data-testid': 'admin-tab-notifications' }}
                    >
                      Notifications
                    </button>
                    <button
                      className={`admin-tab${location.pathname === '/admin/load-test-targets' ? ' admin-tab-active' : ''}`}
                      onClick={() => navigate('/admin/load-test-targets')}
                      type="button"
                      {...{ 'data-testid': 'admin-tab-load-test-targets' }}
                    >
                      Load Test Targets
                    </button>
                  </div>
                  {location.pathname === '/admin/users' ? (
                    <AdminUsers selectedProject={selectedProject} />
                  ) : location.pathname === '/admin/groups' ? (
                    <AdminGroups selectedProject={selectedProject} availableProjects={availableProjects} />
                  ) : location.pathname === '/admin/project-settings' ? (
                    <AdminProjectSettings selectedProject={selectedProject} availableProjects={availableProjects} />
                  ) : location.pathname === '/admin/notifications' ? (
                    <AdminNotifications />
                  ) : location.pathname === '/admin/load-test-targets' ? (
                    <LoadTestAllowlistSettings selectedProject={selectedProject} />
                  ) : (
                    <AdminRoles selectedProject={selectedProject} />
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
          ) : currentView === 'feature-requests' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <FeatureRequestsView />
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'ui-lab' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="ui-lab-view" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <UiLabView project={selectedProject} />
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'pdf-tools' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <PdfToolsRouteGuard selectedProject={selectedProject} isSuperAdmin={isSuperAdmin}>
                <DesktopOnlyGate>
                  <Suspense fallback={<div {...{ 'data-testid': 'pdf-tools-loading' }}><ViewSkeleton /></div>}>
                    <div className="pdf-tools-view" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                      {location.pathname === '/pdf-tools/webviewer-poc' ? (
                        <ApryseWebViewerPoc />
                      ) : location.pathname === '/pdf-tools/nutrient-poc' ? (
                        <NutrientWebSdkPoc />
                      ) : (
                        <PdfAssemblyView key={userId} userId={userId} />
                      )}
                    </div>
                  </Suspense>
                </DesktopOnlyGate>
              </PdfToolsRouteGuard>
            </ErrorBoundary>
          ) : currentView === 'design-module' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <DesignModuleView selectedProject={selectedProject} />
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'load-tests' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <LoadTestsRouteGuard selectedProject={selectedProject} isSuperAdmin={isSuperAdmin}>
                  {(() => {
                    const segments = location.pathname.split('/').filter(Boolean);
                    // /load-tests | /load-tests/new | /load-tests/runs/:runId
                    // /load-tests/:definitionId/runs | /load-tests/:definitionId
                    if (segments[0] === 'load-tests' && segments[1] === 'new') {
                      return <LoadTestDefinitionBuilderView project={selectedProject} />;
                    }
                    if (segments[0] === 'load-tests' && segments[1] === 'runs' && segments[2]) {
                      return (
                        <LoadTestRunDetailView
                          project={selectedProject}
                          runId={segments[2]}
                        />
                      );
                    }
                    if (
                      segments[0] === 'load-tests' &&
                      segments[1] &&
                      segments[2] === 'runs'
                    ) {
                      return (
                        <LoadTestDefinitionBuilderView
                          project={selectedProject}
                          definitionId={segments[1]}
                          section="runs"
                        />
                      );
                    }
                    if (segments[0] === 'load-tests' && segments[1]) {
                      return (
                        <LoadTestDefinitionBuilderView
                          project={selectedProject}
                          definitionId={segments[1]}
                          section="definition"
                        />
                      );
                    }
                    return (
                      <LoadTestsListPage
                        project={selectedProject}
                        canView={isSuperAdmin || can('load-test:view')}
                      />
                    );
                  })()}
                </LoadTestsRouteGuard>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'planning' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <div className="planning-view">
                {error && !isLoading && (
                  <div className="work-items-inline-error" role="status" data-testid="work-items-inline-error">
                    <span>
                      Planning work items couldn&apos;t be refreshed
                      {workItems.length > 0 ? ' — showing the last loaded data.' : '.'}
                    </span>
                    <button
                      type="button"
                      className="work-items-inline-error-retry"
                      onClick={() => { void refetchWorkItems(); }}
                      disabled={isFetchingWorkItems}
                      data-testid="work-items-retry"
                    >
                      {isFetchingWorkItems ? 'Retrying…' : 'Retry'}
                    </button>
                  </div>
                )}
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
                    {/* data-testid-exempt — DetailsPanel owns its panel chrome; no data-testid prop */}
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
        </div>
        <Changelog
          isOpen={showChangelog}
          onClose={() => setShowChangelog(false)}
          onMarkAsRead={handleMarkChangelogAsRead}
          showOnLogin={showChangelogOnLogin}
          onToggleShowOnLogin={handleToggleShowChangelogOnLogin}
          lastSeenVersion={whatsNewLastSeenVersion}
          manualUnavailable={whatsNewManualUnavailable}
        />
        <GuidedWalkthroughHost
          projectId={selectedProject}
          userId={userId}
          enabled={isAuthenticated === true && permissionsLoaded && Boolean(selectedProject)}
          whatsNewSettled={whatsNewAutomaticOverlaySettled}
          whatsNewBlocksWalkthrough={whatsNewBlocksAutomaticWalkthrough}
        />
        {showBetaAnnouncement && !(isSuperAdmin && betaAnnouncementDismissed) && (
          // data-testid-exempt — BetaAnnouncementModal API has no data-testid prop
          <BetaAnnouncementModal
            isSuperAdmin={isSuperAdmin}
            onDismiss={handleDismissBetaAnnouncement}
          />
        )}

        {/* data-testid-exempt — ChatAgentPanel API has no data-testid prop */}
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
