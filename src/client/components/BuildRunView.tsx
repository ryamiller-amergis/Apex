import React, { useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import { BuildApiError, useBuild } from '../hooks/useBuilds';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import { resolveBuildRunTab, type BuildRunTabKey } from './buildRunTabList';
import { BuildRunHeader } from './BuildRunHeader';
import { BuildRunTabs, buildRunPanelId, buildRunTabId } from './BuildRunTabs';
import { BuildOverviewTab } from './BuildOverviewTab';
import { BuildPlanTab } from './BuildPlanTab';
import { BuildTimelineTab } from './BuildTimelineTab';
import styles from './BuildRunView.module.css';

interface BuildRunViewProps {
  project: string;
  buildId: string;
  /** Path segment after the build id; validated here. */
  tab?: string;
}

export const BuildRunView: React.FC<BuildRunViewProps> = ({ project, buildId, tab }) => {
  const { data, error, isLoading, isRefetchError, dataUpdatedAt, refetch } = useBuild(project, buildId);
  const navigate = useNavigate();
  const { tab: activeTab, redirect } = resolveBuildRunTab(tab);
  const basePath = `/builds/${encodeURIComponent(buildId)}`;

  const selectTab = useCallback((next: BuildRunTabKey) => {
    navigate(`${basePath}/${next}`);
  }, [basePath, navigate]);

  const retry = useCallback(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (redirect) navigate(`${basePath}/overview`, { replace: true });
  }, [basePath, navigate, redirect]);

  const { flags, isPending: flagsPending } = useFeatureFlags(project);
  const buildsEnabled = flagsPending || flags[BUILD_FROM_PROMPT_FLAG] === true;

  // @feature-flag:build-from-prompt start winner=enabled
  const flagRegion = buildsEnabled ? (
    // @feature-flag:build-from-prompt enabled-start
    { banner: null, showBack: true }
    // @feature-flag:build-from-prompt enabled-end
  ) : (
    // @feature-flag:build-from-prompt disabled-start
    {
      banner: (
        <div className={styles.banner} role="note" {...{ 'data-testid': 'build-run-flag-off-banner' }}>
          Builds are turned off for this project. You can still read this build.
        </div>
      ),
      showBack: false,
    }
    // @feature-flag:build-from-prompt disabled-end
  );
  // @feature-flag:build-from-prompt end

  let body: React.ReactNode;
  if (isLoading) {
    body = <p className={styles.empty} {...{ 'data-testid': 'build-run-loading' }}>Loading build…</p>;
  } else if (!data) {
    const status = error instanceof BuildApiError ? error.status : null;
    if (status === 403) {
      body = (
        <div className={styles.message} role="alert" {...{ 'data-testid': 'build-run-forbidden' }}>
          You do not have access to this build.
        </div>
      );
    } else if (status === 404) {
      body = (
        <div className={styles.message} role="alert" {...{ 'data-testid': 'build-run-not-found' }}>
          This build does not exist in this project.
        </div>
      );
    } else {
      body = (
        <div className={styles.message} role="alert" {...{ 'data-testid': 'build-run-error' }}>
          <p>Could not load this build.</p>
          <button type="button" className={styles.button} onClick={retry} {...{ 'data-testid': 'build-run-retry' }}>
            Try again
          </button>
        </div>
      );
    }
  } else {
    const staleSince = isRefetchError && dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null;
    const revision = data.currentRevision;
    body = (
      <>
        <BuildRunHeader detail={data} staleSince={staleSince} onRetry={retry} actions={null} />
        <BuildRunTabs active={activeTab} onSelect={selectTab} />
        <div
          role="tabpanel"
          id={buildRunPanelId(activeTab)}
          aria-labelledby={buildRunTabId(activeTab)}
          className={styles.panel}
          {...{ 'data-testid': `build-run-panel-${activeTab}` }}
        >
          {/* data-testid-exempt */}
          {activeTab === 'overview' && <BuildOverviewTab brief={revision?.brief ?? null} onRetry={retry} />}
          {activeTab === 'plan' && (
            // data-testid-exempt
            <BuildPlanTab
              tasks={revision?.tasks ?? []}
              status={data.build.status}
              suspendReason={data.stage.suspendReason}
            />
          )}
          {/* data-testid-exempt */}
          {activeTab === 'timeline' && <BuildTimelineTab project={project} buildId={buildId} />}
        </div>
      </>
    );
  }

  return (
    <div className={styles.root} {...{ 'data-testid': 'build-run-view' }}>
      {flagRegion.showBack && (
        <Link to="/builds" className={styles.back} {...{ 'data-testid': 'build-run-back-link' }}>
          <ArrowLeft size={14} aria-hidden="true" />
          All builds
        </Link>
      )}
      {flagRegion.banner}
      {body}
    </div>
  );
};

export default BuildRunView;
