import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PlaybookGraph, PlaybookLayoutPositions } from '../../shared/types/playbook';
import { useAppShell } from '../hooks/useAppShell';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import {
  PlaybookApiError,
  usePlaybookDefinition,
  usePublishPlaybookDraft,
  useSavePlaybookDraft,
} from '../hooks/usePlaybookDefinitions';
import {
  usePlaybookStepPalette,
  usePlaybookVersionLayout,
  useSavePlaybookLayout,
  useValidatePlaybookConnection,
} from '../hooks/usePlaybookCanvas';
import { layoutPlaybookGraph } from '../utils/playbookCanvasLayout';
import { PlaybookCanvas } from './PlaybookCanvas';
import { PlaybookDryRunPanel } from './PlaybookDryRunPanel';
import styles from './PlaybookCanvas.module.css';

interface PlaybookCanvasPageProps {
  project: string;
  definitionId: string;
}

export const PlaybookCanvasPage: React.FC<PlaybookCanvasPageProps> = ({
  project,
  definitionId,
}) => {
  const canvasEnabled = useFeatureFlag('playbooks-authoring-canvas', project);
  const { can } = useAppShell();
  const canAuthor = can('playbooks:author');
  const detail = usePlaybookDefinition(project, definitionId);
  const palette = usePlaybookStepPalette(project, canvasEnabled);
  const draftVersionId = detail.data?.draft.id ?? null;
  const layoutQuery = usePlaybookVersionLayout(project, definitionId, draftVersionId, canvasEnabled);
  const validateConnection = useValidatePlaybookConnection(project);
  const saveDraft = useSavePlaybookDraft(project, definitionId);
  const saveLayout = useSavePlaybookLayout(project, definitionId, draftVersionId ?? '');
  const publish = usePublishPlaybookDraft(project, definitionId);

  const [graph, setGraph] = useState<PlaybookGraph>({ nodes: [], edges: [] });
  const [positions, setPositions] = useState<PlaybookLayoutPositions>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [savedRevision, setSavedRevision] = useState('');
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    setGraph(detail.data.draft.graph);
    setSavedRevision(detail.data.draft.updatedAt);
  }, [detail.data?.draft.graph, detail.data?.draft.updatedAt, detail.data]);

  useEffect(() => {
    if (layoutQuery.data?.positions) {
      setPositions(layoutQuery.data.positions);
    }
  }, [layoutQuery.data?.positions]);

  const stepLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of palette.data?.items ?? []) {
      map[item.stepType] = item.label;
    }
    return map;
  }, [palette.data?.items]);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);

  const persistDraft = useCallback(async () => {
    if (!detail.data) return;
    setActionError(null);
    try {
      const result = await saveDraft.mutateAsync({
        name: detail.data.definition.name,
        description: detail.data.definition.description ?? '',
        graph,
        expectedDraftUpdatedAt: savedRevision,
      });
      setSavedRevision(result.draft.updatedAt);
      setStatus('Draft saved.');
    } catch (error) {
      setStatus('');
      setActionError(error instanceof Error ? error.message : 'Could not save draft.');
    }
  }, [detail.data, graph, saveDraft, savedRevision]);

  const persistLayout = useCallback(async () => {
    if (!draftVersionId) return;
    try {
      await saveLayout.mutateAsync(positions);
    } catch {
      // Layout save is best-effort after drag; author can use Save layout explicitly.
    }
  }, [draftVersionId, positions, saveLayout]);

  const onTidy = async () => {
    const next = await layoutPlaybookGraph(graph);
    setPositions(next);
    if (draftVersionId && canAuthor) {
      await saveLayout.mutateAsync(next);
      setStatus('Layout tidied.');
    }
  };

  const updateNodeConfig = (configJson: string) => {
    if (!selectedNodeId) return;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configJson) as Record<string, unknown>;
    } catch {
      setActionError('Step config must be valid JSON.');
      return;
    }
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === selectedNodeId ? { ...node, config } : node,
      ),
    }));
  };

  if (!canvasEnabled) {
    return (
      <p className={styles.error} {...{ 'data-testid': 'playbook-canvas-flag-off' }}>
        Playbook authoring canvas is not enabled for this project.
      </p>
    );
  }

  if (detail.isPending || layoutQuery.isPending) {
    return <p className={styles.loading}>Loading playbook canvas…</p>;
  }

  if (detail.isError || !detail.data) {
    return <p className={styles.error}>Could not load this definition.</p>;
  }

  return (
    <div {...{ 'data-testid': 'playbook-canvas-page' }}>
      <div className={styles.headerRow}>
        <div>
          <Link to="/playbooks" {...{ 'data-testid': 'playbook-canvas-back' }}>← Playbooks</Link>
          <h1>{detail.data.definition.name}</h1>
          <p className={styles.nodeMeta}>Authoring canvas (draft v{detail.data.draft.nextVersionNumber})</p>
        </div>
        <div className={styles.toolbar}>
          {canAuthor ? (
            <>
              <button
                type="button"
                className={styles.button}
                disabled={saveDraft.isPending}
                onClick={() => void persistDraft()}
                {...{ 'data-testid': 'playbook-canvas-save-draft' }}
              >
                {saveDraft.isPending ? 'Saving…' : 'Save draft'}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={saveLayout.isPending}
                onClick={() => void persistLayout()}
                {...{ 'data-testid': 'playbook-canvas-save-layout' }}
              >
                Save layout
              </button>
              <button type="button" className={styles.button} onClick={() => void onTidy()} {...{ 'data-testid': 'playbook-canvas-tidy' }}>
                Tidy layout
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={publish.isPending}
                onClick={async () => {
                  setActionError(null);
                  try {
                    const saved = await saveDraft.mutateAsync({
                      name: detail.data.definition.name,
                      description: detail.data.definition.description ?? '',
                      graph,
                      expectedDraftUpdatedAt: savedRevision,
                    });
                    setSavedRevision(saved.draft.updatedAt);
                    await publish.mutateAsync({ expectedDraftUpdatedAt: saved.draft.updatedAt });
                    setStatus('Published.');
                  } catch (error) {
                    setActionError(
                      error instanceof PlaybookApiError ? error.message : 'Publish failed.',
                    );
                  }
                }}
                {...{ 'data-testid': 'playbook-canvas-publish' }}
              >
                Publish
              </button>
            </>
          ) : null}
        </div>
      </div>
      {status ? <p {...{ 'data-testid': 'playbook-canvas-status' }}>{status}</p> : null}
      {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}

      <div className={styles.shell}>
        <aside className={styles.palette} aria-label="Step palette">
          <h2 className={styles.heading}>Steps</h2>
          {(palette.data?.items ?? []).map((item) => (
            <button
              key={item.stepType}
              type="button"
              className={styles.paletteItem}
              draggable={canAuthor}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/playbook-step-type', item.stepType);
                event.dataTransfer.setData('application/playbook-step-label', item.label);
              }}
              disabled={!canAuthor}
              {...{ 'data-testid': `playbook-palette-${item.stepType}` }}
            >
              {item.label}
            </button>
          ))}
        </aside>

        <PlaybookCanvas
          graph={graph}
          positions={positions}
          stepLabels={stepLabels}
          readOnly={!canAuthor}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          onGraphChange={setGraph}
          onPositionsChange={setPositions}
          onValidateConnection={async (candidate) => {
            await validateConnection.mutateAsync({ graph: candidate });
          }}
        />

        <aside className={styles.sidebar} aria-label="Step configuration">
          <h2 className={styles.heading}>Configuration</h2>
          {selectedNode ? (
            <>
              <p className={styles.nodeMeta}>{selectedNode.stepType}</p>
              <textarea
                className={styles.configField}
                value={JSON.stringify(selectedNode.config ?? {}, null, 2)}
                onChange={(event) => updateNodeConfig(event.target.value)}
                disabled={!canAuthor}
                {...{ 'data-testid': 'playbook-canvas-config' }}
              />
            </>
          ) : (
            <p className={styles.nodeMeta}>Select a step to edit its config.</p>
          )}
        </aside>
      </div>

      {canAuthor ? (
        <>
          <p className={styles.nodeMeta}>Dry run uses the last saved draft on the server.</p>
          <PlaybookDryRunPanel
            project={project}
            definitionId={definitionId}
            graph={graph}
            {...{ 'data-testid': 'playbook-dry-run-panel' }}
          />
        </>
      ) : null}
    </div>
  );
};

export default PlaybookCanvasPage;
