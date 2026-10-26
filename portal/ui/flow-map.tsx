import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import {
  applyNodeChanges, Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance, type XYPosition,
} from "@xyflow/react";
import type { Behaviour } from "../types";

type BehaviourNode = Node<{ behaviour: Behaviour; matches: boolean }, "behaviour">;
type GraphState = { signature: string; nodes: BehaviourNode[] };
export type FocusRequest = { id: string; sequence: number };

const nodeWidth = 240;
const nodeHeight = 142;
const fitOptions = { padding: 0.18, minZoom: 0.01, maxZoom: 1 };
const ariaLabels = {
  "node.a11yDescription.default": "Press Enter or Space to inspect this behaviour, Escape to clear selection, or arrow keys to move the selected node.",
  "controls.fitView.ariaLabel": "Fit all behaviours",
};

function componentLayout(ids: string[], topology: graphlib.Graph) {
  const graph = new graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 100, nodesep: 38, marginx: 24, marginy: 24 });
  for (const id of ids) graph.setNode(id, { width: nodeWidth, height: nodeHeight });
  for (const id of ids) for (const edge of topology.outEdges(id) ?? []) graph.setEdge(edge.v, edge.w);
  layout(graph);
  return { graph, ids, width: graph.graph().width as number, height: graph.graph().height as number };
}

function positionsFor(behaviours: Behaviour[]) {
  const topology = new graphlib.Graph();
  for (const behaviour of behaviours) topology.setNode(behaviour.id);
  for (const behaviour of behaviours) {
    for (const dependency of behaviour.dependsOn) if (topology.hasNode(dependency)) topology.setEdge(behaviour.id, dependency);
  }
  const components = graphlib.alg.components(topology).map(ids => componentLayout(ids, topology));
  components.sort((left, right) => right.width * right.height - left.width * left.height);
  const rowWidth = Math.sqrt(components.reduce((area, part) => area + part.width * part.height, 0) * 2);
  const positions = new Map<string, XYPosition>();
  let x = 0, y = 0, rowHeight = 0;
  // Pack disconnected groups, rather than making isolated behaviours one very tall column.
  for (const part of components) {
    if (x > 0 && x + part.width > rowWidth) { x = 0; y += rowHeight + 32; rowHeight = 0; }
    for (const id of part.ids) {
      const node = part.graph.node(id);
      positions.set(id, { x: x + node.x - nodeWidth / 2, y: y + node.y - nodeHeight / 2 });
    }
    x += part.width + 32;
    rowHeight = Math.max(rowHeight, part.height);
  }
  return positions;
}

function updateGraph(current: GraphState | null, behaviours: Behaviour[], signature: string, selectedId: string | null, matches: Set<string>): GraphState {
  const previous = new Map(current?.nodes.map(node => [node.id, node]));
  const positions: Map<string, XYPosition> = current?.signature === signature
    ? new Map(current.nodes.map(node => [node.id, node.position]))
    : positionsFor(behaviours);
  const nodes: BehaviourNode[] = behaviours.map(behaviour => ({
    ...previous.get(behaviour.id),
    id: behaviour.id,
    type: "behaviour",
    data: { behaviour, matches: matches.has(behaviour.id) },
    position: positions.get(behaviour.id)!,
    width: nodeWidth,
    height: nodeHeight,
    selected: behaviour.id === selectedId,
    draggable: true,
    selectable: true,
    connectable: false,
    deletable: false,
    ariaRole: "button",
    ariaLabel: `${behaviour.id}. ${behaviour.description}. ${behaviour.checks.length} configured checks.`,
    domAttributes: { "aria-pressed": behaviour.id === selectedId },
  }));
  return { signature, nodes };
}

const BehaviourCard = memo(function BehaviourCard({ data, selected }: NodeProps<BehaviourNode>) {
  const { behaviour, matches } = data;
  return <div className={`catalogue-flow-node${selected ? " is-selected" : ""}${matches ? " is-match" : ""}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <strong title={behaviour.id}>{behaviour.id}</strong>
    <p title={behaviour.description}>{behaviour.description}</p>
    <span className="catalogue-flow-node-meta">{behaviour.checks.length
      ? `${behaviour.checks.length} configured ${behaviour.checks.length === 1 ? "check" : "checks"}`
      : "No checks mapped"}</span>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
});

const nodeTypes = { behaviour: BehaviourCard };

function graphEdges(behaviours: Behaviour[], selectedId: string | null): Edge[] {
  const ids = new Set(behaviours.map(behaviour => behaviour.id));
  return behaviours.flatMap(behaviour => behaviour.dependsOn.filter(id => ids.has(id)).map(dependency => {
    const related = behaviour.id === selectedId || dependency === selectedId;
    const color = related ? "#247247" : "#a5b2a8";
    return {
      id: JSON.stringify([behaviour.id, dependency]),
      source: behaviour.id,
      target: dependency,
      type: "smoothstep",
      selectable: false,
      deletable: false,
      reconnectable: false,
      focusable: false,
      ariaLabel: `${behaviour.id} depends on ${dependency}`,
      style: { stroke: color, strokeWidth: related ? 2 : 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      zIndex: related ? 1 : 0,
    };
  }));
}

function focusNode(instance: ReactFlowInstance<BehaviourNode>, id: string) {
  const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
  void instance.fitView({ nodes: [{ id }], padding: 0.2, maxZoom: 1.1, duration });
}

export default function FlowMap({ behaviours, selectedId, matchedIds, focusRequest, onSelect }: {
  behaviours: Behaviour[];
  selectedId: string | null;
  matchedIds: string[];
  focusRequest: FocusRequest | null;
  onSelect: (id: string | null) => void;
}) {
  const signature = JSON.stringify(behaviours.map(behaviour => [behaviour.id, behaviour.dependsOn]));
  const matches = useMemo(() => new Set(matchedIds), [matchedIds]);
  const [graph, setGraph] = useState(() => updateGraph(null, behaviours, signature, selectedId, matches));
  const [instance, setInstance] = useState<ReactFlowInstance<BehaviourNode> | null>(null);
  const edges = useMemo(() => graphEdges(behaviours, selectedId), [behaviours, selectedId]);

  useEffect(() => {
    setGraph(current => updateGraph(current, behaviours, signature, selectedId, matches));
  }, [behaviours, signature, selectedId, matches]);

  useEffect(() => {
    if (!focusRequest || !instance) return;
    const frame = requestAnimationFrame(() => focusNode(instance, focusRequest.id));
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, instance]);

  const onNodesChange = useCallback((changes: NodeChange<BehaviourNode>[]) => {
    const viewChanges = changes.filter(change => ["position", "dimensions", "select"].includes(change.type));
    setGraph(current => ({ ...current, nodes: applyNodeChanges(viewChanges, current.nodes) }));
    const selection = changes.filter(change => change.type === "select");
    if (selection.length) onSelect(selection.find(change => change.selected)?.id ?? null);
  }, [onSelect]);

  function initialize(flow: ReactFlowInstance<BehaviourNode>) {
    setInstance(flow);
    if (behaviours.length <= 16) return;
    const connections = (behaviour: Behaviour) => behaviour.dependsOn.length + behaviour.consumers.length;
    const hub = behaviours.reduce((best, current) => connections(current) > connections(best) ? current : best);
    const node = graph.nodes.find(node => node.id === hub.id);
    if (node) void flow.setCenter(node.position.x + nodeWidth / 2, node.position.y + nodeHeight / 2, { zoom: 0.8 });
  }

  return <section className="catalogue-flow" aria-label="Behaviour dependency graph">
    <div className="catalogue-flow-toolbar">
      <span>{behaviours.length} behaviours · {edges.length} recorded {edges.length === 1 ? "relationship" : "relationships"}</span>
      <button type="button" className="catalogue-button" disabled={!selectedId || !instance} onClick={() => {
        if (instance && selectedId) focusNode(instance, selectedId);
      }}>Focus selected</button>
    </div>
    <div className="catalogue-flow-canvas">
      <ReactFlow<BehaviourNode>
        nodes={graph.nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={initialize}
        nodesConnectable={false}
        edgesReconnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        selectNodesOnDrag={false}
        minZoom={0.01}
        maxZoom={1.6}
        fitView={behaviours.length <= 16}
        fitViewOptions={fitOptions}
        ariaLabelConfig={ariaLabels}
      >
        <Background gap={20} size={1} color="#d7dfd8" />
        <Controls aria-label="" showInteractive={false} fitViewOptions={fitOptions} />
        {behaviours.length > 16 && <MiniMap pannable zoomable nodeColor={node => node.selected ? "#247247" : "#c9d5cc"} />}
      </ReactFlow>
    </div>
    <p className="catalogue-flow-note">Arrows point to dependencies. Drag the canvas to pan, scroll to zoom, or select a behaviour to inspect it.</p>
  </section>;
}
