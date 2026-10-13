import '@xyflow/react/dist/style.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  flowToGraph,
  graphToFlow,
  newPlaybookNodeId,
  positionsFromNodes,
  type PlaybookFlowNodeData,
} from '../utils/playbookCanvasGraph';
import { nodeSubtitle, nodeSummary, stepMeta } from './playbookStepCatalog';
import { stepStatusLabel } from './playbookStatusFormat';
import styles from './PlaybookCanvas.module.css';

function decorateEdges<T extends Edge>(edges: T[]): T[] {
  return edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--text-muted)' },
  }));
}

const nodeTypes = {
  playbookStep: PlaybookStepNode,
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
};

function PlaybookStepNode({ data, selected }: NodeProps<Node<PlaybookFlowNodeData>>) {
  const statusClass = data.runStatus ? styles[`status_${data.runStatus}`] : '';
  const meta = stepMeta(data.stepType);
  const Icon = meta.icon;
  const summary = nodeSummary({ config: data.config });
  const subtitle = nodeSubtitle({ id: data.label, config: data.config });
  return (
    <div
      className={`${styles.flowNode} ${selected ? styles.flowNodeSelected : ''} ${statusClass}`}
      {...{ 'data-testid': `playbook-canvas-node-${data.stepType}`, 'data-group': meta.group }}
    >
      <Handle className={styles.handle} type="target" position={Position.Left} isConnectable={!data.readOnly} />
      <span className={styles.nodeIcon} aria-hidden>
        <Icon size={16} strokeWidth={2} />
      </span>
      <span className={styles.nodeText}>
        <span className={styles.nodeLabel}>{meta.title}</span>
        <span className={summary || subtitle !== data.label ? styles.nodeMeta : styles.nodeId}>{subtitle}</span>
      </span>
      {data.runStatus ? (
        <span className={styles.nodeStatus} {...{ 'data-status': data.runStatus }}>
          {stepStatusLabel(data.runStatus as PlaybookStepRunStatus)}
        </span>
      ) : null}
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
}: PlaybookCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
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

  useEffect(() => {
    const revision = JSON.stringify({ graph, positions, selectedNodeId });
    if (revision === graphRevision.current) return;
    graphRevision.current = revision;
    const next = graphToFlow(graph, positions, stepLabels);
    setNodes(
      next.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          readOnly,
          runStatus: stepStatusByNodeId?.[node.id],
        },
        selected: node.id === selectedNodeId,
      })),
    );
    setEdges(decorateEdges(next.edges));
  }, [graph, positions, stepLabels, readOnly, stepStatusByNodeId, selectedNodeId, setNodes, setEdges]);

  const syncGraph = useCallback(
    (nextNodes: typeof nodes, nextEdges: typeof edges) => {
      const nextGraph = flowToGraph(
        nextNodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'playbookStep',
          position: n.position,
          data: n.data,
        })),
        nextEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      );
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
      setConnectionError(null);
      const nextEdges = decorateEdges(addEdge(connection, edges));
      const nextNodes = nodes;
      const candidate = flowToGraph(
        nextNodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'playbookStep',
          position: n.position,
          data: n.data,
        })),
        nextEdges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      );
      if (onValidateConnection) {
        try {
          await onValidateConnection(candidate);
        } catch (error) {
          setConnectionError(error instanceof Error ? error.message : 'Connection refused.');
          return;
        }
      }
      setEdges(nextEdges);
      syncGraph(nextNodes, nextEdges);
    },
    [readOnly, edges, nodes, onValidateConnection, setEdges, syncGraph],
  );

  const onNodeDragStop = useCallback(() => {
    onPositionsChange?.(
      positionsFromNodes(
        nodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'playbookStep',
          position: n.position,
          data: n.data,
        })),
      ),
    );
  }, [nodes, onPositionsChange]);

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
        type: 'playbookStep',
        position,
        data: { stepType, label: label || stepType, config: {}, readOnly: false },
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
        elementsSelectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        fitView
        fitViewOptions={{ padding: 0.35, maxZoom: 1 }}
        attributionPosition="top-right"
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        onPaneClick={() => onSelectNode?.(null)}
        {...{ 'data-testid': 'playbook-canvas' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} />
        <Controls showInteractive={false} position="bottom-left" />
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
