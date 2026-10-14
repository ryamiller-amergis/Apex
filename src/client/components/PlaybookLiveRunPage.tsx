import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type {
  PlaybookGraph,
  PlaybookLayoutPositions,
  PlaybookStepRunStatus,
} from '../../shared/types/playbook';
import { layoutPlaybookGraph, positionsOverlap } from '../utils/playbookCanvasLayout';
import { relativeTime, runStatusLabel } from './playbookStatusFormat';
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

const EMPTY_GRAPH: PlaybookGraph = { nodes: [], edges: [] };

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
  const [tidiedPositions, setTidiedPositions] = useState<PlaybookLayoutPositions | null>(null);

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

  const savedPositions = layoutQuery.data?.positions;
  const versionGraph = graphQuery.data?.graph;
  useEffect(() => {
    setTidiedPositions(null);
    if (!savedPositions || !versionGraph || !positionsOverlap(savedPositions)) return undefined;
    let cancelled = false;
    void layoutPlaybookGraph(versionGraph).then((next) => {
      if (!cancelled) setTidiedPositions(next);
    });
    return () => {
      cancelled = true;
    };
  }, [savedPositions, versionGraph]);

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

  const graph = graphQuery.data?.graph ?? EMPTY_GRAPH;
  const positions = tidiedPositions ?? layoutQuery.data?.positions ?? {};

  return (
    <div className={styles.livePage} {...{ 'data-testid': 'playbook-live-run-page' }}>
      <header className={styles.liveHeader}>
        <Link
          to={`/playbooks/${run.data.definitionId}`}
          className={styles.liveBack}
          aria-label="Back to playbook dashboard"
          {...{ 'data-testid': 'playbook-live-run-back' }}
        >
          <ArrowLeft size={16} aria-hidden />
        </Link>
        <div>
          <h1 className={styles.liveTitle}>{run.data.definitionName}</h1>
          <p className={styles.liveMeta}>
            {runStatusLabel(run.data.status)} · version {run.data.versionNumber} · started{' '}
            {relativeTime(run.data.startedAt)} by {run.data.initiatorUserId}
          </p>
        </div>
      </header>

      <div className={styles.liveFrame}>
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

      <section className={styles.liveSection}>
        <PlaybookRunStepList run={run.data} id={`playbook-live-steps-${runId}`} />
        <PlaybookGateReviewPanel
          project={project}
          run={run.data}
          {...{ 'data-testid': 'playbook-gate-review-panel' }}
        />
        <PlaybookRunActions run={run.data} />
      </section>
    </div>
  );
};

export default PlaybookLiveRunPage;
