import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarClock,
  FlaskConical,
  MousePointerClick,
  Rocket,
  Save,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import type { PlaybookGraph, PlaybookLayoutPositions } from '../../shared/types/playbook';
import { useAppShell } from '../hooks/useAppShell';
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
import { layoutPlaybookGraph, positionsOverlap } from '../utils/playbookCanvasLayout';
import { newPlaybookNodeId, syncBranchEdges } from '../utils/playbookCanvasGraph';
import { PlaybookCanvas } from './PlaybookCanvas';
import { PlaybookDryRunPanel } from './PlaybookDryRunPanel';
import { PlaybookStepInspector } from './PlaybookStepInspector';
import { PlaybookStepLibrary } from './PlaybookStepLibrary';
import { PlaybookSuggestPopover, type PlaybookStepSuggestion } from './PlaybookSuggestPopover';
import { PlaybookTriggersPanel } from './PlaybookTriggersPanel';
import styles from './PlaybookBuilder.module.css';

const USAGE_STORAGE_KEY = 'apex.playbooks.stepUsage';
const LIBRARY_STORAGE_KEY = 'apex.playbooks.libraryCollapsed';
const NEW_STEP_OFFSET_X = 340;

function priorNodeIds(graph: PlaybookGraph, targetId: string): string[] {
  const inbound = new Map<string, string[]>();
  for (const edge of graph.edges) {
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge.from]);
  }
  const result = new Set<string>();
  const pending = [...(inbound.get(targetId) ?? [])];
  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    if (result.has(nodeId)) continue;
    result.add(nodeId);
    pending.push(...(inbound.get(nodeId) ?? []));
  }
  return [...result];
}

function readUsage(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(USAGE_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

interface Toast {
  tone: 'success' | 'error';
  text: string;
}

interface PlaybookCanvasPageProps {
  project: string;
  definitionId: string;
}

export const PlaybookCanvasPage: React.FC<PlaybookCanvasPageProps> = ({
  project,
  definitionId,
}) => {
  const { can } = useAppShell();
  const canAuthor = can('playbooks:author');
  const detail = usePlaybookDefinition(project, definitionId);
  const palette = usePlaybookStepPalette(project, true);
  const draftVersionId = detail.data?.draft.id ?? null;
  const layoutQuery = usePlaybookVersionLayout(project, definitionId, draftVersionId, true);
  const validateConnection = useValidatePlaybookConnection(project);
  const saveDraft = useSavePlaybookDraft(project, definitionId);
  const saveLayout = useSavePlaybookLayout(project, definitionId, draftVersionId ?? '');
  const publish = usePublishPlaybookDraft(project, definitionId);

  const [graph, setGraph] = useState<PlaybookGraph>({ nodes: [], edges: [] });
  const [positions, setPositions] = useState<PlaybookLayoutPositions>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [savedGraphJson, setSavedGraphJson] = useState('');
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const triggers = useQuery<{ triggers: Array<{ id: string; enabled: boolean }> }>({
    queryKey: ['playbook-triggers', project, definitionId],
    queryFn: async () => {
      const response = await fetch(
        `/api/playbooks/triggers?project=${encodeURIComponent(project)}&definitionId=${encodeURIComponent(definitionId)}`,
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      return response.json();
    },
  });
  const activeTriggerCount = (triggers.data?.triggers ?? []).filter((trigger) => trigger.enabled).length;
  const [usage, setUsage] = useState<Record<string, number>>(readUsage);
  const [libraryCollapsed, setLibraryCollapsed] = useState(
    () => window.localStorage.getItem(LIBRARY_STORAGE_KEY) === 'true',
  );
  const savedRevision = useRef('');
  const graphRef = useRef(graph);
  const layoutDirtyRef = useRef(layoutDirty);
  const appliedLayout = useRef<string | null>(null);
  useEffect(() => {
    graphRef.current = graph;
    layoutDirtyRef.current = layoutDirty;
  }, [graph, layoutDirty]);

  // Re-read the server draft only when it changed underneath us; our own saves record their
  // revision first, so the refetch that follows a save does not overwrite edits made since.
  useEffect(() => {
    const draft = detail.data?.draft;
    if (!draft || draft.updatedAt === savedRevision.current) return;
    savedRevision.current = draft.updatedAt;
    setGraph(draft.graph);
    setSavedGraphJson(JSON.stringify(draft.graph));
  }, [detail.data?.draft]);

  // Apply a server layout once per saved revision. A draft save changes the graph identity while
  // the layout query can still be the previous map; reapplying that map would undo a drag.
  const savedPositions = layoutQuery.data?.positions;
  const layoutUpdatedAt = layoutQuery.data?.updatedAt ?? '';
  const draftGraph = detail.data?.draft.graph;
  useEffect(() => {
    if (!savedPositions || !draftGraph || layoutDirty) return undefined;
    if (!positionsOverlap(savedPositions)) {
      if (appliedLayout.current === layoutUpdatedAt) return undefined;
      appliedLayout.current = layoutUpdatedAt;
      setPositions(savedPositions);
      return undefined;
    }
    if (appliedLayout.current === `tidy:${layoutUpdatedAt}`) return undefined;
    let cancelled = false;
    void layoutPlaybookGraph(draftGraph).then((next) => {
      if (cancelled || layoutDirtyRef.current) return;
      appliedLayout.current = `tidy:${layoutUpdatedAt}`;
      setPositions(next);
      setLayoutDirty(true);
    });
    return () => {
      cancelled = true;
    };
  }, [savedPositions, draftGraph, layoutUpdatedAt, layoutDirty]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), toast.tone === 'error' ? 8000 : 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const graphDirty = savedGraphJson !== '' && JSON.stringify(graph) !== savedGraphJson;
  const dirty = graphDirty || layoutDirty;

  const stepLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of palette.data?.items ?? []) map[item.stepType] = item.label;
    return map;
  }, [palette.data?.items]);

  const recordUsage = useCallback((stepTypes: string[]) => {
    if (!stepTypes.length) return;
    setUsage((current) => {
      const next = { ...current };
      for (const stepType of stepTypes) next[stepType] = (next[stepType] ?? 0) + 1;
      try {
        window.localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage can be full or blocked; ranking falls back to the defaults.
      }
      return next;
    });
  }, []);

  const handleGraphChange = useCallback(
    (next: PlaybookGraph) => {
      const known = new Set(graphRef.current.nodes.map((node) => node.id));
      recordUsage(next.nodes.filter((node) => !known.has(node.id)).map((node) => node.stepType));
      setGraph(next);
    },
    [recordUsage],
  );

  const handlePositionsChange = useCallback((next: PlaybookLayoutPositions) => {
    setPositions(next);
    setLayoutDirty(true);
  }, []);

  /**
   * Adds suggested steps after the end of the selected step's line, or after the rightmost step
   * that leads nowhere. A step that already has a successor is not given a second outbound edge.
   * Branch steps route by condition, so nothing is wired out of one.
   */
  const applySuggestions = (suggestions: PlaybookStepSuggestion[]) => {
    if (!canAuthor || !suggestions.length) return;
    const ids = graph.nodes.map((node) => node.id);
    const leaves = graph.nodes.filter((node) => !graph.edges.some((edge) => edge.from === node.id));
    const anchor = graph.nodes.find((node) => node.id === selectedNodeId)
      ?? [...leaves].sort((a, b) => (positions[b.id]?.x ?? 0) - (positions[a.id]?.x ?? 0))[0];
    let end = anchor;
    const seen = new Set<string>();
    while (end && !seen.has(end.id)) {
      seen.add(end.id);
      const outbound = graph.edges.filter((edge) => edge.from === end.id);
      if (end.parallel || end.stepType === 'branch' || outbound.length !== 1) break;
      end = graph.nodes.find((node) => node.id === outbound[0].to) ?? end;
    }
    const canExtend = Boolean(
      end && !end.parallel && end.stepType !== 'branch' && graph.edges.every((edge) => edge.from !== end.id),
    );
    const placedAt = canExtend && end ? end : anchor;
    const start = placedAt && positions[placedAt.id]
      ? { x: positions[placedAt.id].x + NEW_STEP_OFFSET_X, y: positions[placedAt.id].y }
      : { x: 80, y: 160 };
    const nodes: PlaybookGraph['nodes'] = [];
    const edges: PlaybookGraph['edges'] = [];
    const placed: PlaybookLayoutPositions = {};
    let previous = canExtend && end ? end.id : null;
    suggestions.forEach((suggestion, index) => {
      const id = newPlaybookNodeId(suggestion.stepType, [...ids, ...nodes.map((node) => node.id)]);
      nodes.push({
        id,
        stepType: suggestion.stepType,
        ...(Object.keys(suggestion.config).length ? { config: suggestion.config } : {}),
      });
      placed[id] = { x: start.x + index * NEW_STEP_OFFSET_X, y: start.y };
      if (previous) edges.push({ from: previous, to: id });
      previous = id;
    });
    setGraph((current) => ({ nodes: [...current.nodes, ...nodes], edges: [...current.edges, ...edges] }));
    setPositions((current) => ({ ...current, ...placed }));
    setLayoutDirty(true);
    recordUsage(nodes.map((node) => node.stepType));
    setRecommendOpen(false);
    setTriggersOpen(false);
    setDryRunOpen(false);
    setSelectedNodeId(nodes[nodes.length - 1].id);
    setToast({
      tone: 'success',
      text: nodes.length === 1 ? 'Step added. Review it, then save.' : `${nodes.length} steps added. Review them, then save.`,
    });
  };

  const addStep = (stepType: string) => {
    if (!canAuthor) return;
    const id = newPlaybookNodeId(stepType, graph.nodes.map((node) => node.id));
    const placed = Object.values(positions);
    const rightmost = placed.reduce<{ x: number; y: number } | null>(
      (best, point) => (!best || point.x > best.x ? point : best),
      null,
    );
    const position = rightmost
      ? { x: rightmost.x + NEW_STEP_OFFSET_X, y: rightmost.y }
      : { x: 80, y: 160 };
    setPositions((current) => ({ ...current, [id]: position }));
    setGraph((current) => ({ ...current, nodes: [...current.nodes, { id, stepType }] }));
    setLayoutDirty(true);
    recordUsage([stepType]);
    setDryRunOpen(false);
    setTriggersOpen(false);
    setSelectedNodeId(id);
  };

  const deleteStep = (nodeId: string) => {
    setGraph((current) => ({
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
    setPositions((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
    setLayoutDirty(true);
    setSelectedNodeId(null);
  };

  const updateNodeConfig = (config: Record<string, unknown>) => {
    if (!selectedNodeId) return;
    setGraph((current) => syncBranchEdges({
      ...current,
      nodes: current.nodes.map((node) => {
        if (node.id !== selectedNodeId) return node;
        const { config: _previous, ...rest } = node;
        return Object.keys(config).length ? { ...rest, config } : rest;
      }),
    }));
  };

  /** Saves whatever is pending. Returns the draft revision to publish against, or null on error. */
  const save = useCallback(async (): Promise<string | null> => {
    if (!detail.data) return null;
    try {
      if (graphDirty) {
        const result = await saveDraft.mutateAsync({
          name: detail.data.definition.name,
          description: detail.data.definition.description ?? '',
          graph,
          expectedDraftUpdatedAt: savedRevision.current,
        });
        savedRevision.current = result.draft.updatedAt;
        setSavedGraphJson(JSON.stringify(graph));
      }
      if (layoutDirty && draftVersionId) {
        await saveLayout.mutateAsync(positions);
        setLayoutDirty(false);
      }
      return savedRevision.current;
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Could not save.' });
      return null;
    }
  }, [detail.data, draftVersionId, graph, graphDirty, layoutDirty, positions, saveDraft, saveLayout]);

  const onSave = useCallback(async () => {
    if (!dirty) return;
    if ((await save()) !== null) setToast({ tone: 'success', text: 'Draft saved.' });
  }, [dirty, save]);

  const onPublish = async () => {
    const revision = await save();
    if (revision === null) return;
    try {
      const result = await publish.mutateAsync({ expectedDraftUpdatedAt: revision });
      savedRevision.current = result.draft.updatedAt;
      setToast({
        tone: 'success',
        text: `Published version ${result.publishedVersion.versionNumber}.`,
      });
    } catch (error) {
      setToast({
        tone: 'error',
        text: error instanceof PlaybookApiError ? error.message : 'Publish failed.',
      });
    }
  };

  const onTidy = async () => {
    const next = await layoutPlaybookGraph(graph);
    setPositions(next);
    setLayoutDirty(true);
  };

  useEffect(() => {
    if (!canAuthor) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canAuthor, onSave]);

  if (detail.isPending || layoutQuery.isPending) {
    return <p className={styles.pageMessage}>Loading playbook…</p>;
  }

  if (detail.isError || !detail.data) {
    return <p className={styles.pageMessage}>Could not load this playbook.</p>;
  }

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const busy = saveDraft.isPending || saveLayout.isPending || publish.isPending;

  return (
    <div className={styles.page} {...{ 'data-testid': 'playbook-canvas-page' }}>
      <header className={styles.topBar}>
        <Link
          to={`/playbooks/${definitionId}`}
          className={styles.backButton}
          aria-label="Back to playbook dashboard"
          title="Back to dashboard"
          {...{ 'data-testid': 'playbook-canvas-back' }}
        >
          <ArrowLeft size={16} aria-hidden />
        </Link>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{detail.data.definition.name}</h1>
          <span className={styles.draftPill}>Draft · v{detail.data.draft.nextVersionNumber}</span>
          {canAuthor ? (
            <span
              className={`${styles.saveState} ${dirty ? styles.saveStateDirty : ''}`}
              {...{ 'data-testid': 'playbook-canvas-save-state' }}
            >
              {busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}
            </span>
          ) : (
            <span className={styles.saveState}>View only</span>
          )}
        </div>

        {canAuthor ? (
          <div className={styles.actions}>
            <div className={styles.popoverAnchor}>
              <button
                type="button"
                className={`${styles.suggestButton} ${recommendOpen ? styles.suggestButtonActive : ''}`}
                aria-expanded={recommendOpen}
                onClick={() => setRecommendOpen((open) => !open)}
                {...{ 'data-testid': 'playbook-canvas-recommend' }}
              >
                <Sparkles size={15} aria-hidden /> Suggest steps
              </button>
              {recommendOpen ? (
                <PlaybookSuggestPopover
                  project={project}
                  definitionId={definitionId}
                  onApply={applySuggestions}
                  onClose={() => setRecommendOpen(false)}
                  {...{ 'data-testid': 'playbook-recommend-form' }}
                />
              ) : null}
            </div>
            <button
              type="button"
              className={`${styles.ghostButton} ${triggersOpen ? styles.ghostButtonActive : ''}`}
              aria-pressed={triggersOpen}
              onClick={() => {
                setTriggersOpen((open) => !open);
                setDryRunOpen(false);
              }}
              title={activeTriggerCount ? `${activeTriggerCount} active trigger(s)` : 'No trigger: this Playbook runs only when started by hand'}
              {...{ 'data-testid': 'playbook-canvas-triggers' }}
            >
              <CalendarClock size={15} aria-hidden /> Triggers
              <span
                className={`${styles.countBadge} ${activeTriggerCount ? '' : styles.countBadgeEmpty}`}
                {...{ 'data-testid': 'playbook-canvas-trigger-count' }}
              >
                {triggers.isSuccess ? activeTriggerCount : '·'}
              </span>
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => void onTidy()}
              title="Arrange steps automatically"
              {...{ 'data-testid': 'playbook-canvas-tidy' }}
            >
              <WandSparkles size={15} aria-hidden /> Tidy
            </button>
            <button
              type="button"
              className={`${styles.ghostButton} ${dryRunOpen ? styles.ghostButtonActive : ''}`}
              aria-pressed={dryRunOpen}
              onClick={() => {
                setDryRunOpen((open) => !open);
                setTriggersOpen(false);
              }}
              {...{ 'data-testid': 'playbook-canvas-test-run' }}
            >
              <FlaskConical size={15} aria-hidden /> Test run
            </button>
            <span className={styles.actionDivider} aria-hidden />
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!dirty || busy}
              onClick={() => void onSave()}
              title="Save (Ctrl+S)"
              {...{ 'data-testid': 'playbook-canvas-save-draft' }}
            >
              <Save size={15} aria-hidden /> {saveDraft.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || graph.nodes.length === 0}
              onClick={() => void onPublish()}
              {...{ 'data-testid': 'playbook-canvas-publish' }}
            >
              <Rocket size={15} aria-hidden /> {publish.isPending ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        ) : null}
      </header>

      <div className={styles.body}>
        {canAuthor ? (
          <PlaybookStepLibrary
            items={palette.data?.items ?? []}
            usage={usage}
            canAuthor={canAuthor}
            collapsed={libraryCollapsed}
            onToggleCollapsed={() => {
              setLibraryCollapsed((current) => {
                window.localStorage.setItem(LIBRARY_STORAGE_KEY, String(!current));
                return !current;
              });
            }}
            onAdd={addStep}
          />
        ) : null}

        <div className={styles.stage}>
          <PlaybookCanvas
            graph={graph}
            positions={positions}
            stepLabels={stepLabels}
            readOnly={!canAuthor}
            selectedNodeId={selectedNodeId}
            onSelectNode={(nodeId) => {
              setSelectedNodeId(nodeId);
              if (nodeId) {
                setDryRunOpen(false);
                setTriggersOpen(false);
              }
            }}
            onGraphChange={handleGraphChange}
            onPositionsChange={handlePositionsChange}
            onValidateConnection={async (candidate) => {
              await validateConnection.mutateAsync({ graph: candidate });
            }}
          />

          {graph.nodes.length === 0 ? (
            <div className={styles.emptyHint} {...{ 'data-testid': 'playbook-canvas-empty' }}>
              <MousePointerClick size={22} aria-hidden />
              <p className={styles.emptyTitle}>Start with a step</p>
              <p className={styles.emptyBody}>
                Drag one in from the library, or click it to place it here. Connect steps by
                dragging from the right edge of one to the left edge of the next.
              </p>
            </div>
          ) : null}

          {triggersOpen ? (
            <aside className={`${styles.drawer} ${styles.triggersDrawer}`} aria-label="Triggers" {...{ 'data-testid': 'playbook-canvas-triggers-drawer' }}>
              <header className={styles.drawerHeader}>
                <CalendarClock size={16} aria-hidden className={styles.drawerIcon} />
                <h2 className={styles.drawerTitle}>Triggers</h2>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => setTriggersOpen(false)}
                  aria-label="Close triggers"
                  {...{ 'data-testid': 'playbook-canvas-triggers-close' }}
                >
                  <X size={16} aria-hidden />
                </button>
              </header>
              {!detail.data.currentPublishedVersionId ? (
                <p className={styles.drawerLead}>
                  Triggers start the published version. Publish this draft before a trigger can run it.
                </p>
              ) : null}
              <PlaybookTriggersPanel
                project={project}
                definitionId={definitionId}
                canManage={canAuthor}
                showHeading={false}
                {...{ 'data-testid': 'playbook-triggers' }}
              />
            </aside>
          ) : dryRunOpen && canAuthor ? (
            <PlaybookDryRunPanel
              project={project}
              definitionId={definitionId}
              dirty={dirty}
              onBeforeRun={async () => (await save()) !== null}
              onSelectNode={(nodeId) => {
                setDryRunOpen(false);
                setSelectedNodeId(nodeId);
              }}
              onClose={() => setDryRunOpen(false)}
              {...{ 'data-testid': "playbook-dry-run-panel" }}
            />
          ) : selectedNode ? (
            <PlaybookStepInspector
              key={selectedNode.id}
              project={project}
              node={selectedNode}
              nextNodeIds={graph.edges.filter((edge) => edge.from === selectedNode.id).map((edge) => edge.to)}
              paletteItem={palette.data?.items.find((item) => item.stepType === selectedNode.stepType)}
              otherNodeIds={graph.nodes.map((node) => node.id).filter((id) => id !== selectedNode.id)}
              priorNodeIds={priorNodeIds(graph, selectedNode.id)}
              allNodes={graph.nodes}
              paletteItems={palette.data?.items ?? []}
              canAuthor={canAuthor}
              onChange={updateNodeConfig}
              onDelete={() => deleteStep(selectedNode.id)}
              onClose={() => setSelectedNodeId(null)}
              {...{ 'data-testid': "playbook-step-inspector" }}
            />
          ) : null}

          {toast ? (
            <div
              className={`${styles.toast} ${toast.tone === 'error' ? styles.toastError : ''}`}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              {...{ 'data-testid': 'playbook-canvas-status' }}
            >
              {toast.text}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default PlaybookCanvasPage;
