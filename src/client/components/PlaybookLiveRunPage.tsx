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
import { PlaybookRunActions } from './PlaybookRunActions';
import { PlaybookGateReviewPanel } from './PlaybookGateReviewPanel';
import { PlaybookCanvas } from './PlaybookCanvas';
import { PlaybookLiveStepPanel } from './PlaybookLiveStepPanel';
import { stepMeta } from './playbookStepCatalog';
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
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [panelDismissed, setPanelDismissed] = useState(false);

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
  const activeStep = [...run.data.steps]
    .reverse()
    .find((step) => step.status === 'running' || step.status === 'suspended');
  const retryableStep = run.data.steps.find(
    (step) => step.stepId === run.data.currentStepId && step.status === 'failed_retryable',
  );
  // With nothing picked, the panel follows whatever needs attention: the running step, or the one
  // that failed and can be retried.
  const panelStep = selectedStep ?? (panelDismissed ? null : activeStep ?? retryableStep ?? null);

  const openStep = (stepRunId: string, expand: boolean) => {
    setSelectedStepRunId(stepRunId);
    setPanelDismissed(false);
    if (expand) setPanelExpanded(true);
  };

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
        <div className={styles.liveToolbar}>
          {activeStep ? (
            <button
              type="button"
              className={styles.liveWatch}
              onClick={() => openStep(activeStep.id, true)}
              {...{ 'data-testid': "playbook-live-run-watch" }}
            >
              <span className={styles.liveDot} aria-hidden />
              {activeStep.status === 'suspended' ? 'Waiting on' : 'Running'} {stepMeta(activeStep.stepType).title}
              {' · '}View log
            </button>
          ) : null}
          <PlaybookRunActions run={run.data} variant="toolbar" />
        </div>
      </header>

      <PlaybookGateReviewPanel
        project={project}
        run={run.data}
        {...{ 'data-testid': 'playbook-gate-review-panel' }}
      />

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
            selectedNodeId={panelStep?.stepId ?? null}
            onSelectNode={(nodeId) => {
              const step = nodeId
                ? run.data.steps.find((candidate) => candidate.stepId === nodeId)
                : undefined;
              if (step) {
                openStep(step.id, false);
              } else if (nodeId === null) {
                setPanelExpanded(false);
              }
            }}
          />
        )}
        {panelStep ? (
          <PlaybookLiveStepPanel
            key={panelStep.id}
            {...{ 'data-testid': 'playbook-live-step-panel' }}
            project={project}
            runId={runId}
            step={panelStep}
            suspension={run.data.suspension}
            report={run.data.steps
              .map((candidate) => candidate.outputInline?.reportMd)
              .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null}
            expanded={panelExpanded}
            onExpandedChange={setPanelExpanded}
            onClose={() => {
              setSelectedStepRunId(null);
              setPanelDismissed(true);
              setPanelExpanded(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
};

export default PlaybookLiveRunPage;
