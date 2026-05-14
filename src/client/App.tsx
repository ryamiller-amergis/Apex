import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { DueDateReasonModal } from './components/DueDateReasonModal';
import { Changelog } from './components/Changelog';
import { Login } from './components/Login';
import { ViewErrorFallback } from './components/ViewErrorFallback';
import { ViewSkeleton } from './components/ViewSkeleton';
import { AppHeader } from './components/AppHeader';
import { PlanningTabs } from './components/PlanningTabs';
import { ProjectSelector } from './components/ProjectSelector';
import { AgentHome } from './components/AgentHome';
import { ChatAgentPanel } from './components/ChatAgentPanel';
import { useAppShell } from './hooks/useAppShell';
import { useChatThread, useSkillRepos, useStartChat } from './hooks/useChatThreads';
import { DEFAULT_MODEL_ID } from './config/models';
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
const BacklogView = lazy(() => import('./components/BacklogView'));
const AdminRoles = lazy(() => import('./components/AdminRoles').then(m => ({ default: m.AdminRoles })));
const AdminUsers = lazy(() => import('./components/AdminUsers').then(m => ({ default: m.AdminUsers })));

type PlanningTab = 'cycle-time' | 'dev-stats' | 'qa' | 'ai-analysis' | 'roadmap' | 'releases';

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [chatOpen, setChatOpen] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const { data: activeThread = null } = useChatThread(activeThreadId);

  type CurrentView = 'project-selector' | 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'admin';
  const currentView: CurrentView =
    location.pathname === '/'
      ? 'project-selector'
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
                : location.pathname.startsWith('/admin')
                  ? 'admin'
                  : 'calendar';

  const planningTab = (location.pathname.split('/')[2] as PlanningTab) || 'dev-stats';

  // Close the slide-out panel when landing on the home view — the full-page
  // AgentHome already provides the complete chat experience there.
  useEffect(() => {
    if (currentView === 'home') {
      setChatOpen(false);
    }
  }, [currentView]);

  const {
    isAuthenticated,
    can,
    permissionsLoaded,
    workItems,
    error,
    isLoading,
    isSaving,
    selectedItem,
    setSelectedItem,
    theme,
    toggleTheme,
    showChangelog,
    setShowChangelog,
    hasUnreadChangelog,
    handleMarkChangelogAsRead,
    handleLogout,
    selectedProject,
    selectedAreaPath,
    changeProject,
    changeAreaPath,
    scheduledItems,
    unscheduledItems,
    pendingDueDateChange,
    handleDueDateChange,
    handleConfirmDueDateChange,
    handleCancelDueDateChange,
    handleFieldUpdate,
  } = useAppShell();

  // Guard admin routes: redirect to home if user lacks admin:roles permission.
  // Wait for permissionsLoaded to avoid redirecting before the fetch completes.
  useEffect(() => {
    if (currentView === 'admin' && permissionsLoaded && !can('admin:roles')) {
      navigate('/home');
    }
  }, [currentView, permissionsLoaded, can, navigate]);

  const { data: skillRepos = [], isLoading: isLoadingSkillRepos } = useSkillRepos(selectedProject || null);
  const startChat = useStartChat();
  const defaultAgentRepo = skillRepos.find(
    (repo) => repo.name.toLowerCase() === selectedProject.toLowerCase(),
  ) ?? skillRepos[0];

  const handleStartPanelChat = useCallback(async () => {
    setChatOpen(true);
    if (!defaultAgentRepo || startChat.isPending) return;
    setActiveThreadId(null);
    try {
      const result = await startChat.mutateAsync({
        kickoff: {
          project: selectedProject,
          repo: defaultAgentRepo.name,
          branch: defaultAgentRepo.defaultBranch ?? 'main',
          model: DEFAULT_MODEL_ID,
        },
      });
      setActiveThreadId(result.threadId);
    } catch {
      // Error shown inside the panel
    }
  }, [defaultAgentRepo, selectedProject, startChat]);

  if (isAuthenticated === null) return <div>Loading...</div>;
  if (!isAuthenticated) return <Login />;

  if (currentView === 'project-selector') {
    return (
      <ErrorBoundary FallbackComponent={ViewErrorFallback}>
        <ProjectSelector
          selectedProject={selectedProject}
          onSelect={(project) => {
            changeProject(project);
            changeAreaPath(project);
            navigate('/home');
          }}
        />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
      <DndProvider backend={HTML5Backend}>
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
            currentView={currentView as 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'admin'}
            planningTab={planningTab}
            theme={theme}
            hasUnreadChangelog={hasUnreadChangelog}
            can={can}
            onNavigateHome={() => navigate('/home')}
            onNavigateCalendar={() => navigate('/calendar')}
            onNavigatePlanning={() => navigate(`/planning/${planningTab}`)}
            onNavigateCloudCost={() => navigate('/cloud-cost')}
            onNavigateBacklog={() => navigate('/backlog')}
            onNavigateAdmin={() => navigate('/admin/roles')}
            onOpenChangelog={() => setShowChangelog(true)}
            onToggleTheme={toggleTheme}
            onLogout={handleLogout}
            onOpenAgentChat={currentView !== 'home' ? () => setChatOpen(true) : undefined}
          />
          {error && <div className="error-banner">{error}</div>}

          {currentView === 'home' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <AgentHome selectedProject={selectedProject} />
            </ErrorBoundary>
          ) : currentView === 'calendar' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                {!isLoading && (
                  <div className="calendar-view">
                    <UnscheduledList
                      workItems={unscheduledItems}
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
                  <BacklogView project={selectedProject} areaPath={selectedAreaPath} />
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'admin' && can('admin:roles') ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="admin-container">
                  {location.pathname === '/admin/users' ? (
                    <AdminUsers />
                  ) : (
                    <AdminRoles />
                  )}
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : currentView === 'planning' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <div className="planning-view">
                <PlanningTabs
                  activeTab={planningTab}
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
        />

        <ChatAgentPanel
          thread={activeThread}
          isOpen={chatOpen}
          onClose={() => setChatOpen(false)}
          onNewChat={handleStartPanelChat}
          onSelectThread={(id) => setActiveThreadId(id || null)}
          canStartNewChat={!!defaultAgentRepo && !isLoadingSkillRepos && !startChat.isPending}
          isStartingNewChat={startChat.isPending}
          newChatError={startChat.error?.message}
        />
      </DndProvider>
    </ErrorBoundary>
  );
}

export default App;
