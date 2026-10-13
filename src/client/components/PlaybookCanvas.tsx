import '@xyflow/react/dist/style.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
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
import styles from './PlaybookCanvas.module.css';

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
  return (
    <div
      className={`${styles.flowNode} ${selected ? styles.flowNodeSelected : ''} ${statusClass}`}
      {...{ 'data-testid': `playbook-canvas-node-${data.stepType}` }}
    >
      <Handle type="target" position={Position.Left} isConnectable={!data.readOnly} />
      <div className={styles.nodeLabel}>{data.label}</div>
      <div className={styles.nodeMeta}>{data.stepType}</div>
      {data.runStatus ? <div className={styles.nodeMeta}>{data.runStatus}</div> : null}
      <Handle type="source" position={Position.Right} isConnectable={!data.readOnly} />
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
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const graphRevision = useRef('');

  useEffect(() => {
    const revision = JSON.stringify({ graph, positions });
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
    setEdges(next.edges);
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
      const nextEdges = addEdge(connection, edges);
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
      const id = newPlaybookNodeId();
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

  const onNodesDelete = useCallback(
    (deleted: Node<PlaybookFlowNodeData>[]) => {
      if (readOnly) return;
      const deletedIds = new Set(deleted.map((node) => node.id));
      const nextNodes = nodes.filter((node) => !deletedIds.has(node.id));
      const nextEdges = edges.filter(
        (edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target),
      );
      setNodes(nextNodes);
      setEdges(nextEdges);
      syncGraph(nextNodes, nextEdges);
      if (selectedNodeId && deletedIds.has(selectedNodeId)) onSelectNode?.(null);
    },
    [readOnly, nodes, edges, selectedNodeId, setNodes, setEdges, syncGraph, onSelectNode],
  );

  return (
    <div className={styles.canvasPane} {...{ 'data-testid': 'playbook-canvas-pane' }}>
      {connectionError ? (
        <p className={styles.error} role="alert" {...{ 'data-testid': 'playbook-canvas-connection-error' }}>
          {connectionError}
        </p>
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
        onNodesDelete={onNodesDelete}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        deleteKeyCode={readOnly ? null : 'Delete'}
        fitView
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        onPaneClick={() => onSelectNode?.(null)}
        {...{ 'data-testid': 'playbook-canvas' }}
      >
        <Background />
        <Controls showInteractive={!readOnly} />
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
