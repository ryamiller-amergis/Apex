import { lazy, Suspense } from 'react';
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
import { useAppShell } from './hooks/useAppShell';
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

type PlanningTab = 'cycle-time' | 'dev-stats' | 'qa' | 'ai-analysis' | 'roadmap' | 'releases';

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const currentView: 'calendar' | 'planning' | 'cloudcost' | 'backlog' = location.pathname.startsWith('/planning')
    ? 'planning'
    : location.pathname === '/cloud-cost'
      ? 'cloudcost'
      : location.pathname.startsWith('/backlog')
        ? 'backlog'
        : 'calendar';

  const planningTab = (location.pathname.split('/')[2] as PlanningTab) || 'dev-stats';

  const {
    isAuthenticated,
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
    availableProjects,
    availableAreaPaths,
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

  if (isAuthenticated === null) return <div>Loading...</div>;
  if (!isAuthenticated) return <Login />;

  return (
    <ErrorBoundary FallbackComponent={ViewErrorFallback}>
      <DndProvider backend={HTML5Backend}>
        <div className="app">
          {isLoading && (
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
            currentView={currentView}
            planningTab={planningTab}
            availableProjects={availableProjects}
            availableAreaPaths={availableAreaPaths}
            selectedProject={selectedProject}
            selectedAreaPath={selectedAreaPath}
            isLoading={isLoading}
            theme={theme}
            hasUnreadChangelog={hasUnreadChangelog}
            onNavigateCalendar={() => navigate('/')}
            onNavigatePlanning={() => navigate(`/planning/${planningTab}`)}
            onNavigateCloudCost={() => navigate('/cloud-cost')}
            onNavigateBacklog={() => navigate('/backlog')}
            onChangeProject={changeProject}
            onChangeAreaPath={changeAreaPath}
            onOpenChangelog={() => setShowChangelog(true)}
            onToggleTheme={toggleTheme}
            onLogout={handleLogout}
          />
          {error && <div className="error-banner">{error}</div>}

          {!isLoading && currentView === 'calendar' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
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
              </Suspense>
            </ErrorBoundary>
          ) : !isLoading && currentView === 'cloudcost' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="cloudcost-view">
                  <CloudCost project={selectedProject} areaPath={selectedAreaPath} />
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : !isLoading && currentView === 'backlog' ? (
            <ErrorBoundary FallbackComponent={ViewErrorFallback}>
              <Suspense fallback={<ViewSkeleton />}>
                <div className="backlog-view">
                  <BacklogView project={selectedProject} areaPath={selectedAreaPath} />
                </div>
              </Suspense>
            </ErrorBoundary>
          ) : !isLoading && (
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
          )}
        </div>
        <Changelog
          isOpen={showChangelog}
          onClose={() => setShowChangelog(false)}
          onMarkAsRead={handleMarkChangelogAsRead}
        />
      </DndProvider>
    </ErrorBoundary>
  );
}

export default App;
