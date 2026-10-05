import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useHomeDashboard } from '../hooks/useHomeDashboard';
import { HomeDashboardSection } from './HomeDashboardSection';
import { ProductSetup, type FoundationReview } from './ProductSetup';
import {
  draftProductFoundation,
  reviseProductFoundation,
  saveProductFoundation,
  useProductSetup,
} from '../hooks/useProductSetup';
import { useAddProjectTeammate } from '../hooks/useRbac';
import styles from './AgentHome.module.css';

export type HomeView = 'chat' | 'status';

interface AgentHomeProps {
  selectedProject: string;
  isActive?: boolean;
  onHomeViewChange?: (view: HomeView) => void;
  onRestoreThread?: (threadId: string) => void;
}

const storageKey = (project: string) => `apex-home-view:${project}`;

const loadHomeView = (project: string): HomeView => {
  try {
    return localStorage.getItem(storageKey(project)) === 'status' ? 'status' : 'chat';
  } catch {
    return 'chat';
  }
};

export const AgentHome: React.FC<AgentHomeProps> = ({
  selectedProject,
  isActive = true,
  onHomeViewChange,
  onRestoreThread,
}) => {
  const [projectViews, setProjectViews] = useState<Record<string, HomeView>>({});
  const [setupStep, setSetupStep] = useState<'people' | 'chat'>('people');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [foundationDraft, setFoundationDraft] = useState<string | null>(null);
  const [foundationWorking, setFoundationWorking] = useState(false);
  const [foundationError, setFoundationError] = useState<string | null>(null);
  const [foundationSaved, setFoundationSaved] = useState(false);
  const [foundationProgress, setFoundationProgress] = useState<string | null>(null);
  const restoredProjectRef = useRef<string | null>(null);
  const restoredUrlThreadRef = useRef<string | null>(null);
  const foundationRetryRef = useRef<{ progress: string; task: () => Promise<string | null> } | null>(null);
  const dashboard = useHomeDashboard(selectedProject, 'team');
  const setupQuery = useProductSetup(selectedProject || null);
  const addTeammate = useAddProjectTeammate(selectedProject);
  const [searchParams] = useSearchParams();
  const preferredView = projectViews[selectedProject] ?? loadHomeView(selectedProject);
  const threadFromUrl = searchParams.get('thread');
  const statusAvailable = dashboard.data === undefined
    || dashboard.data.incompletePipeline !== null
    || dashboard.data.artifactCycleTime !== null;
  const view = threadFromUrl || (!dashboard.isLoading && !statusAvailable)
    ? 'chat'
    : preferredView;
  const setupOn = setupQuery.data?.active === true;
  const setupUnresolved = Boolean(selectedProject)
    && setupQuery.data === undefined
    && setupQuery.isFetched !== true;

  const foundationReview = useMemo<FoundationReview>(() => ({
    reply: foundationDraft,
    error: foundationError,
    progressLabel: foundationProgress,
    saved: foundationSaved,
  }), [foundationDraft, foundationError, foundationProgress, foundationSaved]);

  const runFoundation = useCallback(async (
    progress: string,
    task: () => Promise<string | null>,
  ) => {
    setFoundationProgress(progress);
    setFoundationWorking(true);
    setFoundationError(null);
    try {
      const markdown = await task();
      if (markdown) setFoundationDraft(markdown);
      return true;
    } catch (err) {
      setFoundationError(err instanceof Error ? err.message : 'The draft could not be created.');
      return false;
    } finally {
      setFoundationWorking(false);
    }
  }, []);

  const selectView = (nextView: HomeView) => {
    setProjectViews((current) => ({ ...current, [selectedProject]: nextView }));
    try { localStorage.setItem(storageKey(selectedProject), nextView); } catch { /* noop */ }
    onHomeViewChange?.(nextView);
  };

  useEffect(() => {
    setSetupStep('people');
    setSetupError(null);
    setFoundationDraft(null);
    setFoundationError(null);
    setFoundationSaved(false);
    setFoundationProgress(null);
    foundationRetryRef.current = null;
  }, [selectedProject]);

  useEffect(() => {
    if (!isActive) return;
    if (!threadFromUrl) {
      try { localStorage.setItem(storageKey(selectedProject), view); } catch { /* noop */ }
    }
    onHomeViewChange?.(view);
  }, [isActive, onHomeViewChange, selectedProject, threadFromUrl, view]);

  useEffect(() => {
    if (setupUnresolved || setupOn) return;

    if (threadFromUrl) {
      if (
        restoredUrlThreadRef.current === threadFromUrl
        && restoredProjectRef.current === selectedProject
      ) {
        return;
      }
      restoredUrlThreadRef.current = threadFromUrl;
      restoredProjectRef.current = selectedProject;
      onRestoreThread?.(threadFromUrl);
      return;
    }

    restoredUrlThreadRef.current = null;
    if (restoredProjectRef.current === selectedProject) return;
    restoredProjectRef.current = selectedProject;
    const storedThreadId = sessionStorage.getItem(`agentHomeThreadId:${selectedProject}`);
    if (storedThreadId) onRestoreThread?.(storedThreadId);
  }, [onRestoreThread, selectedProject, setupOn, setupUnresolved, threadFromUrl]);

  const addSetupTeammate = (email: string) => {
    setSetupError(null);
    addTeammate.mutate(email, { onError: (err) => setSetupError(err.message) });
  };

  const refetchSetup = setupQuery.refetch;

  const productSetupPanel = (
    <ProductSetup
      step={setupStep}
      candidates={setupQuery.data?.candidates ?? []}
      adding={addTeammate.isPending}
      error={setupError}
      onAddEmail={addSetupTeammate}
      onAddExisting={addSetupTeammate}
      onSkip={() => setSetupStep('chat')}
      onContinue={() => setSetupStep('chat')}
      onChooseStep={setSetupStep}
      initialFoundationAnswers={setupQuery.data?.foundationAnswers ?? []}
      onCompleteFoundation={(answers) => {
        const progress = 'Writing the draft from your answers';
        const task = async () => (await draftProductFoundation(selectedProject, answers)).markdown;
        foundationRetryRef.current = { progress, task };
        void runFoundation(progress, task);
      }}
      creatingDraft={foundationWorking}
      conversationStarted={foundationWorking || foundationDraft !== null || foundationError !== null || foundationSaved}
      review={foundationReview}
      onConfirmDraft={() => {
        if (!foundationDraft) return;
        const progress = 'Saving PRODUCT.md';
        const markdown = foundationDraft;
        const task = async () => {
          await saveProductFoundation(selectedProject, markdown);
          setFoundationSaved(true);
          await refetchSetup();
          return null;
        };
        foundationRetryRef.current = { progress, task };
        void runFoundation(progress, task);
      }}
      onReviseDraft={(changes) => {
        if (!foundationDraft) return;
        const progress = 'Updating the draft';
        const markdown = foundationDraft;
        const task = async () => (await reviseProductFoundation(selectedProject, markdown, changes)).markdown;
        foundationRetryRef.current = { progress, task };
        void runFoundation(progress, task);
      }}
      onRetryDraft={() => {
        const retry = foundationRetryRef.current;
        if (retry) void runFoundation(retry.progress, retry.task);
      }}
    />
  );

  return (
    <main
      className={styles.dashboardPage}
      style={setupOn ? { zIndex: 2 } : undefined}
      data-testid="agent-home-dashboard"
    >
      <div className={styles.tabStrip} role="tablist" aria-label="Home view">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'chat'}
          className={`${styles.tab} ${view === 'chat' ? styles.activeTab : ''}`}
          onClick={() => selectView('chat')}
          data-testid="home-view-chat"
        >
          Chat
        </button>
        {!setupOn && statusAvailable && (
          <button
            type="button"
            role="tab"
            aria-selected={view === 'status'}
            className={`${styles.tab} ${view === 'status' ? styles.activeTab : ''}`}
            onClick={() => selectView('status')}
            data-testid="home-view-status"
          >
            Project status
          </button>
        )}
      </div>
      {setupOn ? (
        <div className={`${styles.compose} ${styles.setupCompose}`} role="tabpanel" aria-label="Product setup">
          <div className={styles.composeInner}>
            {productSetupPanel}
          </div>
        </div>
      ) : view === 'status' && statusAvailable && (
        <div className={styles.statusView} role="tabpanel" aria-label="Project status">
          <HomeDashboardSection
            payload={dashboard.data}
            isLoading={dashboard.isLoading}
            onRetry={() => { void dashboard.refetch(); }}
          />
        </div>
      )}
    </main>
  );
};
