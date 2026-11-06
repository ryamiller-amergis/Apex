import '@xyflow/react/dist/style.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { PlaybookGraph, PlaybookLayoutPositions, PlaybookStepRunStatus } from '../../shared/types/playbook';
import {
  flowNodeType,
  flowToGraph,
  graphToFlow,
  initialStepConfig,
  newPlaybookNodeId,
  positionsAfterDrag,
  positionsFromNodes,
  type PlaybookFlowEdge,
  type PlaybookFlowNode,
  type PlaybookFlowNodeData,
} from '../utils/playbookCanvasGraph';
import { nodeSubtitle, nodeSummary, stepMeta } from './playbookStepCatalog';
import { stepStatusLabel } from './playbookStatusFormat';
import styles from './PlaybookCanvas.module.css';

function asFlowNodes(nodes: Node<PlaybookFlowNodeData>[]): PlaybookFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type ?? 'playbookStep',
    position: node.position,
    data: node.data,
  }));
}

function asFlowEdges(edges: Edge[]): PlaybookFlowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: edge.data as PlaybookFlowEdge['data'],
  }));
}

const NO_EDGES: ReadonlySet<string> = new Set();

export function edgeIssueKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** Draws every connection with an arrow. A connection the server flagged is drawn in the error colour. */
function decorateEdges<T extends Edge>(edges: T[], flagged: ReadonlySet<string> = NO_EDGES): T[] {
  return edges.map((edge) => {
    const bad = flagged.has(edgeIssueKey(edge.source, edge.target));
    const color = bad ? 'var(--error-color)' : 'var(--text-muted)';
    return {
      ...edge,
      type: 'smoothstep',
      style: bad ? { stroke: color, strokeWidth: 2 } : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
    };
  });
}

function NodeIssueBadge({
  issues,
  testId,
}: {
  issues: string[] | undefined;
  testId: string;
}) {
  if (!issues?.length) return null;
  return (
    <span
      className={styles.nodeIssue}
      role="img"
      aria-label={`${issues.length} problem${issues.length === 1 ? '' : 's'}: ${issues.join(' ')}`}
      title={issues.join('\n')}
      {...{ 'data-testid': testId }}
    >
      <TriangleAlert size={12} aria-hidden />
      {issues.length > 1 ? issues.length : null}
    </span>
  );
}

const nodeTypes = {
  playbookStep: PlaybookStepNode,
  playbookConnector: PlaybookConnectorNode,
};

type PlaybookCanvasProps = {
  graph: PlaybookGraph;
  positions: PlaybookLayoutPositions;
  stepLabels: Record<string, string>;
  readOnly?: boolean;
  stepStatusByNodeId?: Record<string, PlaybookStepRunStatus>;
  onGraphChange?: (graph: PlaybookGraph) => void;
  onPositionsChange?: (positions: PlaybookLayoutPositions) => void;
  onValidateConnection?: (graph: PlaybookGraph) => Promise<void>;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  /** Problems the server found, by step id. A flagged step shows a warning badge. */
  nodeIssues?: Record<string, string[]>;
  /** Connections the server found a problem on. They are drawn in the error colour. */
  edgeIssues?: ReadonlyArray<{ from: string; to: string }>;
};

function NodeRunStatus({ status }: { status: string | undefined }) {
  if (!status) return null;
  if (status === 'running') {
    return (
      <span className={styles.nodeRunning} role="status" aria-label="Running" {...{ 'data-status': status }}>
        <i /><i /><i />
      </span>
    );
  }
  return (
    <span className={styles.nodeStatus} {...{ 'data-status': status }}>
      {stepStatusLabel(status as PlaybookStepRunStatus)}
    </span>
  );
}

function PlaybookStepNode({ data, selected }: NodeProps<Node<PlaybookFlowNodeData>>) {
  const statusClass = data.runStatus ? styles[`status_${data.runStatus}`] : '';
  const meta = stepMeta(data.stepType);
  const Icon = meta.icon;
  const summary = nodeSummary({ config: data.config });
  const subtitle = nodeSubtitle({ id: data.label, config: data.config });
  return (
    <div
      className={`${styles.flowNode} ${selected ? styles.flowNodeSelected : ''} ${data.issues?.length ? styles.nodeInvalid : ''} ${statusClass}`}
      {...{ 'data-testid': `playbook-canvas-node-${data.stepType}`, 'data-group': meta.group }}
    >
      <NodeIssueBadge
        issues={data.issues}
        testId={`playbook-canvas-node-issue-${data.label}`}
        {...{ 'data-testid': `playbook-canvas-node-issue-${data.label}` }}
      />
      <Handle className={styles.handle} type="target" position={Position.Left} isConnectable={!data.readOnly} />
      <span className={styles.nodeIcon} aria-hidden>
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className={styles.nodeText}>
        <span className={styles.nodeLabel}>{meta.title}</span>
        <span className={summary || subtitle !== data.label ? styles.nodeMeta : styles.nodeId}>{subtitle}</span>
      </span>
      <NodeRunStatus status={data.runStatus} />
      <Handle className={styles.handle} type="source" position={Position.Right} isConnectable={!data.readOnly} />
    </div>
  );
}

function PlaybookConnectorNode({ data, selected }: NodeProps<Node<PlaybookFlowNodeData>>) {
  const statusClass = data.runStatus ? styles[`status_${data.runStatus}`] : '';
  const meta = stepMeta(data.stepType);
  const Icon = meta.icon;
  const summary = nodeSummary({ config: data.config });
  return (
    <div
      className={`${styles.connectorNode} ${selected ? styles.flowNodeSelected : ''} ${data.issues?.length ? styles.nodeInvalid : ''} ${statusClass}`}
      {...{ 'data-testid': `playbook-canvas-node-${data.stepType}`, 'data-group': meta.group }}
    >
      <NodeIssueBadge
        issues={data.issues}
        testId={`playbook-canvas-node-issue-${data.label}`}
        {...{ 'data-testid': `playbook-canvas-node-issue-${data.label}` }}
      />
      <Handle className={styles.handle} type="target" position={Position.Left} isConnectable={!data.readOnly} />
      <span className={styles.connectorIcon} aria-hidden>
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className={styles.connectorLabel}>{summary || meta.title}</span>
      <NodeRunStatus status={data.runStatus} />
      <Handle className={styles.handle} type="source" position={Position.Right} isConnectable={!data.readOnly} />
    </div>
  );
}

function PlaybookCanvasInner({
  graph,
  positions,
  stepLabels,
  readOnly = false,
  stepStatusByNodeId,
  onGraphChange,
  onPositionsChange,
  onValidateConnection,
  selectedNodeId,
  onSelectNode,
  nodeIssues,
  edgeIssues,
}: PlaybookCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const flaggedEdges = useMemo(
    () => new Set((edgeIssues ?? []).map((edge) => edgeIssueKey(edge.from, edge.to))),
    [edgeIssues],
  );
  const initial = useMemo(
    () => graphToFlow(graph, positions, stepLabels),
    [graph, positions, stepLabels],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PlaybookFlowNodeData>>(
    initial.nodes as Node<PlaybookFlowNodeData>[],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(decorateEdges(initial.edges));
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const graphRevision = useRef('');
  const overlayRevision = useRef('');
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);

  useEffect(() => {
    const revision = JSON.stringify({ graph, positions, selectedNodeId });
    const overlay = JSON.stringify({
      readOnly,
      stepStatusByNodeId: stepStatusByNodeId ?? null,
      nodeIssues: nodeIssues ?? null,
      edgeIssues: edgeIssues ?? null,
    });
    // Status and problems arrive on their own. Rebuilding the nodes from props would drop a drag
    // still in progress.
    if (revision === graphRevision.current) {
      if (overlay === overlayRevision.current) return;
      overlayRevision.current = overlay;
      setNodes((current) =>
        current.map((node) => ({
          ...node,
          selected: node.id === selectedNodeId,
          data: {
            ...node.data,
            readOnly,
            runStatus: stepStatusByNodeId?.[node.id],
            issues: nodeIssues?.[node.id],
          },
        })),
      );
      setEdges((current) => decorateEdges(current, flaggedEdges));
      return;
    }
    graphRevision.current = revision;
    overlayRevision.current = overlay;
    const next = graphToFlow(graph, positions, stepLabels);
    setNodes(
      next.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          readOnly,
          runStatus: stepStatusByNodeId?.[node.id],
          issues: nodeIssues?.[node.id],
        },
        selected: node.id === selectedNodeId,
      })),
    );
    setEdges(decorateEdges(next.edges, flaggedEdges));
  }, [
    graph,
    positions,
    stepLabels,
    readOnly,
    stepStatusByNodeId,
    selectedNodeId,
    nodeIssues,
    edgeIssues,
    flaggedEdges,
    setNodes,
    setEdges,
  ]);

  const syncGraph = useCallback(
    (nextNodes: typeof nodes, nextEdges: typeof edges) => {
      const nextGraph = flowToGraph(asFlowNodes(nextNodes), asFlowEdges(nextEdges));
      onGraphChange?.(nextGraph);
      onPositionsChange?.(positionsFromNodes(
        nextNodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'playbookStep',
          position: n.position,
          data: n.data,
        })),
      ));
    },
    [onGraphChange, onPositionsChange],
  );

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (readOnly || !connection.source || !connection.target) return;
      const source = connection.source;
      const target = connection.target;
      setConnectionError(null);
      const candidateEdges = decorateEdges(addEdge(connection, edgesRef.current));
      const candidate = flowToGraph(asFlowNodes(nodesRef.current), asFlowEdges(candidateEdges));
      if (onValidateConnection) {
        try {
          await onValidateConnection(candidate);
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : 'Connection refused.');
          return;
        }
      }
      // Validation awaited a server round trip. Apply the edge onto whatever the canvas is now,
      // so a drop or delete during that wait is not replaced by the pre-request snapshot.
      const latestNodes = nodesRef.current;
      const latestEdges = edgesRef.current;
      if (!latestNodes.some((node) => node.id === source) || !latestNodes.some((node) => node.id === target)) {
        return;
      }
      const alreadyConnected = latestEdges.some((edge) => edge.source === source && edge.target === target);
      const nextEdges = alreadyConnected ? latestEdges : decorateEdges(addEdge(connection, latestEdges));
      setEdges(nextEdges);
      syncGraph(latestNodes, nextEdges);
    },
    [readOnly, onValidateConnection, setEdges, syncGraph],
  );

  const onNodeDragStop = useCallback((_event: unknown, _node: Node, dragged: Node[]) => {
    onPositionsChange?.(positionsAfterDrag(
      asFlowNodes(nodesRef.current),
      asFlowNodes(dragged as Node<PlaybookFlowNodeData>[]),
    ));
  }, [onPositionsChange]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      if (readOnly) return;
      event.preventDefault();
      const stepType = event.dataTransfer.getData('application/playbook-step-type');
      const label = event.dataTransfer.getData('application/playbook-step-label');
      if (!stepType) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = newPlaybookNodeId(stepType, nodes.map((node) => node.id));
      const newNode: Node<PlaybookFlowNodeData> = {
        id,
        type: flowNodeType(stepType),
        position,
        data: { stepType, label: label || stepType, config: initialStepConfig(stepType), readOnly: false },
      };
      const nextNodes = [...nodes, newNode];
      setNodes(nextNodes);
      syncGraph(nextNodes, edges);
      onSelectNode?.(id);
    },
    [readOnly, screenToFlowPosition, nodes, edges, setNodes, syncGraph, onSelectNode],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // One handler for nodes and edges: a node deletion also removes its edges, and two callbacks
  // reading the same stale state would each write back what the other removed.
  const onDelete = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      if (readOnly) return;
      const deletedNodeIds = new Set(deletedNodes.map((node) => node.id));
      const deletedEdgeIds = new Set(deletedEdges.map((edge) => edge.id));
      const nextNodes = nodes.filter((node) => !deletedNodeIds.has(node.id));
      const nextEdges = edges.filter(
        (edge) =>
          !deletedEdgeIds.has(edge.id)
          && !deletedNodeIds.has(edge.source)
          && !deletedNodeIds.has(edge.target),
      );
      setNodes(nextNodes);
      setEdges(nextEdges);
      syncGraph(nextNodes, nextEdges);
      if (selectedNodeId && deletedNodeIds.has(selectedNodeId)) onSelectNode?.(null);
    },
    [readOnly, nodes, edges, selectedNodeId, setNodes, setEdges, syncGraph, onSelectNode],
  );

  return (
    <div className={styles.canvasPane} {...{ 'data-testid': 'playbook-canvas-pane' }}>
      {connectionError ? (
        <div className={styles.connectionBanner} role="alert" {...{ 'data-testid': 'playbook-canvas-connection-error' }}>
          <p className={styles.connectionTitle}>Connection not allowed</p>
          <p className={styles.connectionBody}>{connectionError}</p>
          <button
            type="button"
            className={styles.connectionDismiss}
            onClick={() => setConnectionError(null)}
            aria-label="Dismiss"
            {...{ 'data-testid': 'playbook-canvas-connection-dismiss' }}
          >
            ×
          </button>
        </div>
      ) : null}
      <ReactFlow
        className={styles.canvas}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDelete={onDelete}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly || Boolean(onSelectNode)}
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        fitView
        fitViewOptions={{ padding: 0.35, maxZoom: 1 }}
        attributionPosition="top-right"
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        onPaneClick={() => onSelectNode?.(null)}
        {...{ 'data-testid': 'playbook-canvas' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} />
        <Controls showInteractive={false} position={readOnly ? 'top-left' : 'bottom-left'} />
      </ReactFlow>
    </div>
  );
}

export const PlaybookCanvas: React.FC<PlaybookCanvasProps> = (props) => (
  <ReactFlowProvider>
    <PlaybookCanvasInner {...props} />
  </ReactFlowProvider>
);

export default PlaybookCanvas;
