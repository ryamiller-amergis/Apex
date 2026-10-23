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
import { PlaybookStepDetailDrawer } from './PlaybookStepDetailDrawer';
import styles from './PlaybookCanvas.module.css';

const EMPTY_GRAPH: PlaybookGraph = { nodes: [], edges: [] };

interface PlaybookLiveRunPageProps {
  project: string;
  runId: string;
}

export const PlaybookLiveRunPage: React.FC<PlaybookLiveRunPageProps> = ({ project, runId }) => {
  const run = usePlaybookRun(project, runId);
  usePlaybookRunInvalidation(project, runId, true);

  const definitionId = run.data?.definitionId ?? null;
  const versionId = run.data?.definitionVersionId ?? null;
  const graphQuery = usePlaybookVersionGraph(project, definitionId, versionId, true);
  const layoutQuery = usePlaybookVersionLayout(project, definitionId, versionId, true);
  const palette = usePlaybookStepPalette(project, true);
  const [tidiedPositions, setTidiedPositions] = useState<PlaybookLayoutPositions | null>(null);
  const [selectedStepRunId, setSelectedStepRunId] = useState<string | null>(null);

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

  if (run.isPending) {
    return <p className={styles.loading}>Loading run…</p>;
  }

  if (run.isError || !run.data) {
    return <p className={styles.error}>Could not load this run.</p>;
  }

  const graph = graphQuery.data?.graph ?? EMPTY_GRAPH;
  const positions = tidiedPositions ?? layoutQuery.data?.positions ?? {};
  const selectedStep = run.data.steps.find((step) => step.id === selectedStepRunId) ?? null;

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
            selectedNodeId={selectedStep?.stepId ?? null}
            onSelectNode={(nodeId) => {
              const step = run.data.steps.find((candidate) => candidate.stepId === nodeId);
              setSelectedStepRunId(step?.id ?? null);
            }}
          />
        )}
      </div>

      {selectedStep ? (
        <PlaybookStepDetailDrawer
          project={project}
          runId={runId}
          step={selectedStep}
          suspension={run.data.suspension}
          onClose={() => setSelectedStepRunId(null)}
          data-testid="playbook-live-step-detail"
        />
      ) : null}

      <section className={styles.liveSection}>
        <PlaybookRunStepList
          run={run.data}
          id={`playbook-live-steps-${runId}`}
        />
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
