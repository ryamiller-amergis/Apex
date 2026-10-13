import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { PlaybookStepRunStatus } from '../../shared/types/playbook';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { usePlaybookRun } from '../hooks/usePlaybookRuns';
import { usePlaybookRunInvalidation } from '../hooks/usePlaybookRunInvalidation';
import {
  usePlaybookVersionGraph,
  usePlaybookVersionLayout,
} from '../hooks/usePlaybookCanvas';
import { usePlaybookStepPalette } from '../hooks/usePlaybookCanvas';
import { PlaybookRunStepList } from './PlaybookRunStepList';
import { PlaybookRunActions } from './PlaybookRunActions';
import { PlaybookGateReviewPanel } from './PlaybookGateReviewPanel';
import { PlaybookCanvas } from './PlaybookCanvas';
import styles from './PlaybookCanvas.module.css';

interface PlaybookLiveRunPageProps {
  project: string;
  runId: string;
}

export const PlaybookLiveRunPage: React.FC<PlaybookLiveRunPageProps> = ({ project, runId }) => {
  const canvasEnabled = useFeatureFlag('playbooks-authoring-canvas', project);
  const run = usePlaybookRun(project, runId);
  usePlaybookRunInvalidation(project, runId, canvasEnabled);

  const definitionId = run.data?.definitionId ?? null;
  const versionId = run.data?.definitionVersionId ?? null;
  const graphQuery = usePlaybookVersionGraph(project, definitionId, versionId, canvasEnabled);
  const layoutQuery = usePlaybookVersionLayout(project, definitionId, versionId, canvasEnabled);
  const palette = usePlaybookStepPalette(project, canvasEnabled);

  const stepLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of palette.data?.items ?? []) {
      map[item.stepType] = item.label;
    }
    return map;
  }, [palette.data?.items]);

  const stepStatusByNodeId = useMemo(() => {
    const map: Record<string, PlaybookStepRunStatus> = {};
    for (const step of run.data?.steps ?? []) {
      map[step.stepId] = step.status;
    }
    return map;
  }, [run.data?.steps]);

  if (!canvasEnabled) {
    return (
      <p className={styles.error} {...{ 'data-testid': 'playbook-live-run-flag-off' }}>
        Live run canvas is not enabled for this project.
      </p>
    );
  }

  if (run.isPending) {
    return <p className={styles.loading}>Loading run…</p>;
  }

  if (run.isError || !run.data) {
    return <p className={styles.error}>Could not load this run.</p>;
  }

  const graph = graphQuery.data?.graph ?? { nodes: [], edges: [] };
  const positions = layoutQuery.data?.positions ?? {};

  return (
    <div {...{ 'data-testid': 'playbook-live-run-page' }}>
      <div className={styles.headerRow}>
        <div>
          <Link to="/playbooks" {...{ 'data-testid': 'playbook-live-run-back' }}>← Playbooks</Link>
          <h1>{run.data.definitionName}</h1>
          <p className={styles.nodeMeta}>
            Run {run.data.runId} · pinned v{run.data.versionNumber} · {run.data.status}
          </p>
        </div>
      </div>

      <div className={styles.shell}>
        <div style={{ gridColumn: '1 / -1' }}>
          {graphQuery.isPending ? (
            <p className={styles.loading}>Loading graph…</p>
          ) : (
            <PlaybookCanvas
              graph={graph}
              positions={positions}
              stepLabels={stepLabels}
              readOnly
              stepStatusByNodeId={stepStatusByNodeId}
            />
          )}
        </div>
      </div>

      <PlaybookRunStepList run={run.data} id={`playbook-live-steps-${runId}`} />
      <PlaybookGateReviewPanel
        project={project}
        run={run.data}
        {...{ 'data-testid': 'playbook-gate-review-panel' }}
      />
      <PlaybookRunActions run={run.data} />
    </div>
  );
};

export default PlaybookLiveRunPage;
