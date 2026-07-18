"use client";

import {
  drag,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type GraphNodeType = "case" | "actor" | "issue" | "source" | "document" | "argument";
type EvidenceBand = "non_soutenu" | "faible" | "moyenne" | "forte";

export type SimulationGraphNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  detail?: string;
  cycle_created?: number;
  cycle_ended?: number | null;
  evidence_score?: number;
  evidence_band?: EvidenceBand;
  evidence_metrics?: {
    legal_sources?: number;
    factual_exhibits?: number;
    issues?: number;
    refutations?: number;
  };
  refutation_count?: number;
  contested_by_ids?: string[];
};

export type SimulationGraph = {
  nodes: SimulationGraphNode[];
  edges: { source: string; target: string; label: string; cycle_created?: number }[];
};

type EgoGraphNode = SimulationGraphNode & { distance: number };

type EgoNetworkProps = {
  graph: SimulationGraph;
  centerId: string;
  pinned: boolean;
  onClose?: () => void;
  onTogglePin: (nodeId: string) => void;
  onFocusNode: (nodeId: string) => void;
};

type ForceNode = SimulationGraphNode & SimulationNodeDatum;
type ForceLink = SimulationLinkDatum<ForceNode> & {
  id: string;
  label: string;
  source: string | ForceNode;
  target: string | ForceNode;
  curve: number;
};

type GraphSelection =
  | { kind: "node"; node: SimulationGraphNode }
  | { kind: "edge"; edge: { source: string; target: string; label: string } };

type GraphSelectionControl = (selection: GraphSelection | null) => void;

const NODE_META: Record<GraphNodeType, { label: string; color: string; glyph: string }> = {
  case: { label: "Dossier", color: "#e11d48", glyph: "D" },
  actor: { label: "Acteur", color: "#2563eb", glyph: "A" },
  issue: { label: "Question de droit", color: "#7c3aed", glyph: "Q" },
  source: { label: "Source juridique", color: "#059669", glyph: "S" },
  document: { label: "Piece PDF", color: "#ea580c", glyph: "P" },
  argument: { label: "Argument", color: "#be123c", glyph: "A" }
};

const NODE_RING: Record<GraphNodeType, number> = {
  case: 0,
  actor: 1,
  issue: 1,
  source: 2,
  document: 2,
  argument: 3
};

const EVIDENCE_META: Record<EvidenceBand, { label: string; color: string }> = {
  non_soutenu: { label: "Non soutenu", color: "#94a3b8" },
  faible: { label: "Faible", color: "#f59e0b" },
  moyenne: { label: "Moyenne", color: "#0ea5e9" },
  forte: { label: "Forte", color: "#16a34a" }
};

function evidenceBand(node: SimulationGraphNode): EvidenceBand {
  if (node.evidence_band && EVIDENCE_META[node.evidence_band]) return node.evidence_band;
  const score = Number(node.evidence_score || 0);
  if (score < 20) return "non_soutenu";
  if (score < 45) return "faible";
  if (score < 70) return "moyenne";
  return "forte";
}

function clampLabel(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(1, length - 1)).trim()}...` : value;
}

function endpointNode(endpoint: string | number | ForceNode, byId: Map<string, ForceNode>): ForceNode | undefined {
  return typeof endpoint === "object" ? endpoint : byId.get(String(endpoint));
}

function edgePath(link: ForceLink, byId: Map<string, ForceNode>): string {
  const source = endpointNode(link.source, byId);
  const target = endpointNode(link.target, byId);
  if (!source || !target || source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return "";

  if (source.id === target.id) {
    const radius = 25;
    return `M ${source.x + 8} ${source.y - 8} C ${source.x + radius} ${source.y - radius}, ${source.x + radius} ${source.y + radius}, ${source.x + 7} ${source.y + 10}`;
  }

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const midpointX = (source.x + target.x) / 2;
  const midpointY = (source.y + target.y) / 2;
  const curvature = link.curve || 0;
  const controlX = midpointX - (dy / distance) * curvature;
  const controlY = midpointY + (dx / distance) * curvature;
  return `M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`;
}

function edgeLabelPosition(link: ForceLink, byId: Map<string, ForceNode>): { x: number; y: number } {
  const source = endpointNode(link.source, byId);
  const target = endpointNode(link.target, byId);
  if (!source || !target || source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return { x: 0, y: 0 };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const curvature = link.curve || 0;
  return {
    x: (source.x + target.x) / 2 - (dy / distance) * curvature * 0.5,
    y: (source.y + target.y) / 2 + (dx / distance) * curvature * 0.5
  };
}

function buildEgoNetwork(graph: SimulationGraph, centerId: string, maxNodes = 20): { nodes: EgoGraphNode[]; edges: SimulationGraph["edges"] } {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(centerId)) return { nodes: [], edges: [] };

  const adjacency = new Map<string, Set<string>>();
  graph.edges.forEach((edge) => {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return;
    adjacency.set(edge.source, new Set([...(adjacency.get(edge.source) || []), edge.target]));
    adjacency.set(edge.target, new Set([...(adjacency.get(edge.target) || []), edge.source]));
  });

  const distanceById = new Map<string, number>([[centerId, 0]]);
  const queue = [centerId];
  while (queue.length) {
    const currentId = queue.shift() as string;
    const distance = distanceById.get(currentId) || 0;
    if (distance >= 2) continue;
    (adjacency.get(currentId) || new Set<string>()).forEach((neighborId) => {
      if (distanceById.has(neighborId)) return;
      distanceById.set(neighborId, distance + 1);
      queue.push(neighborId);
    });
  }

  const orderedIds = [...distanceById.entries()]
    .sort(([leftId, leftDistance], [rightId, rightDistance]) => {
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return (nodeById.get(leftId)?.label || "").localeCompare(nodeById.get(rightId)?.label || "");
    })
    .slice(0, maxNodes)
    .map(([id]) => id);
  const selectedIds = new Set(orderedIds);
  return {
    nodes: orderedIds.map((id) => ({ ...nodeById.get(id) as SimulationGraphNode, distance: distanceById.get(id) || 0 })),
    edges: graph.edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
  };
}

function EgoNetwork({ graph, centerId, pinned, onClose, onTogglePin, onFocusNode }: EgoNetworkProps) {
  const ego = useMemo(() => buildEgoNetwork(graph, centerId), [centerId, graph]);
  const center = ego.nodes.find((node) => node.id === centerId);
  const positions = useMemo(() => {
    const next = new Map<string, { x: number; y: number }>();
    if (!center) return next;
    next.set(center.id, { x: 160, y: 112 });
    ([1, 2] as const).forEach((distance) => {
      const ring = ego.nodes.filter((node) => node.distance === distance);
      const radius = distance === 1 ? 55 : 98;
      ring.forEach((node, index) => {
        const angle = -Math.PI / 2 + (index / Math.max(1, ring.length)) * Math.PI * 2;
        next.set(node.id, { x: 160 + Math.cos(angle) * radius, y: 112 + Math.sin(angle) * radius });
      });
    });
    return next;
  }, [center, ego.nodes]);

  if (!center) return null;
  const label = NODE_META[center.type]?.label || "Entite";

  return (
    <section className="legal-force-ego-network" aria-label={`Voisinage de ${center.label}`}>
      <header>
        <div>
          <span className="simulation-eyebrow">Contexte local</span>
          <h3>{clampLabel(center.label, 42)}</h3>
          <p>{ego.nodes.length} entites, profondeur maximale de 2 sauts</p>
        </div>
        <div className="legal-force-ego-actions">
          <button aria-pressed={pinned} onClick={() => onTogglePin(center.id)} title={pinned ? "Retirer des voisinages epingles" : "Epingler ce voisinage"} type="button">
            <span className="material-symbols-outlined">{pinned ? "push_pin" : "push_pin"}</span>
            {pinned ? "Epingle" : "Epingler"}
          </button>
          {onClose ? <button aria-label="Fermer le voisinage" onClick={onClose} title="Fermer" type="button"><span className="material-symbols-outlined">close</span></button> : null}
        </div>
      </header>
      <div className="legal-force-ego-canvas">
        <svg aria-label={`Sous-graphe autour de ${center.label}`} role="img" viewBox="0 0 320 224">
          <g className="legal-force-ego-edges">
            {ego.edges.map((edge, index) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) return null;
              return <line key={`${edge.source}-${edge.target}-${index}`} x1={source.x} x2={target.x} y1={source.y} y2={target.y} />;
            })}
          </g>
          <g className="legal-force-ego-nodes">
            {ego.nodes.map((node) => {
              const position = positions.get(node.id);
              if (!position) return null;
              const color = node.type === "argument" ? EVIDENCE_META[evidenceBand(node)].color : NODE_META[node.type].color;
              return <g className={`legal-force-ego-node distance-${node.distance} ${node.id === center.id ? "center" : ""}`} key={node.id} onClick={() => onFocusNode(node.id)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onFocusNode(node.id); }} transform={`translate(${position.x},${position.y})`}>
                <circle className="legal-force-ego-node-aura" r={node.id === center.id ? 21 : 15} />
                <circle className="legal-force-ego-node-core" fill={color} r={node.id === center.id ? 12 : 8} />
                <text className="legal-force-ego-node-glyph" textAnchor="middle" dy=".34em">{NODE_META[node.type].glyph}</text>
                <text className="legal-force-ego-node-label" textAnchor="middle" y={node.id === center.id ? 32 : 25}>{clampLabel(node.label, node.id === center.id ? 22 : 15)}</text>
                <title>{`${label}: ${node.label} (${node.distance} saut${node.distance > 1 ? "s" : ""})`}</title>
              </g>;
            })}
          </g>
        </svg>
      </div>
      <footer><span><i className="center" /> centre</span><span><i /> voisins directs</span><span><i className="far" /> voisins a 2 sauts</span></footer>
    </section>
  );
}

export function SimulationRelationshipGraph({
  graph,
  isWorking = false,
  variant = "full",
  focusedNodeId = null,
  scope = "all",
  onNodeSelect
}: {
  graph: SimulationGraph;
  isWorking?: boolean;
  variant?: "full" | "embedded";
  focusedNodeId?: string | null;
  scope?: "all" | "structure" | "debate";
  onNodeSelect?: (nodeId: string) => void;
}) {
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const selectionControlRef = useRef<GraphSelectionControl>(() => undefined);
  const [dimensions, setDimensions] = useState({ width: 920, height: 590 });
  const [showEdgeLabels, setShowEdgeLabels] = useState(variant === "full");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [hoveredNode, setHoveredNode] = useState<SimulationGraphNode | null>(null);
  const [egoNodeId, setEgoNodeId] = useState<string | null>(null);
  const [pinnedEgoNodeIds, setPinnedEgoNodeIds] = useState<string[]>([]);
  const [activeCycle, setActiveCycle] = useState(0);
  const [isReplaying, setIsReplaying] = useState(false);
  const [visibleEvidenceBands, setVisibleEvidenceBands] = useState<Set<EvidenceBand>>(
    () => new Set(Object.keys(EVIDENCE_META) as EvidenceBand[])
  );

  const scopedGraph = useMemo<SimulationGraph>(() => {
    if (scope === "all") return graph;
    const allowedTypes = scope === "structure"
      ? new Set<GraphNodeType>(["case", "issue", "source", "document"])
      : new Set<GraphNodeType>(["case", "actor", "issue", "argument"]);
    const nodes = graph.nodes.filter((node) => allowedTypes.has(node.type));
    const nodeIds = new Set(nodes.map((node) => node.id));
    return { nodes, edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
  }, [graph, scope]);

  const maxCycle = useMemo(() => Math.max(
    0,
    ...scopedGraph.nodes.map((node) => Number(node.cycle_created || 0)),
    ...scopedGraph.edges.map((edge) => Number(edge.cycle_created || 0))
  ), [scopedGraph.edges, scopedGraph.nodes]);

  const visibleNodes = useMemo(() => scopedGraph.nodes.filter((node) => {
      if (!NODE_META[node.type] || Number(node.cycle_created || 0) > activeCycle) return false;
      return node.type !== "argument" || visibleEvidenceBands.has(evidenceBand(node));
    }), [activeCycle, scopedGraph.nodes, visibleEvidenceBands]);

  const visibleGraph = useMemo<SimulationGraph>(() => {
    const nodeIds = new Set(visibleNodes.map((node) => node.id));
    return {
      nodes: visibleNodes,
      edges: scopedGraph.edges.filter((edge) => Number(edge.cycle_created || 0) <= activeCycle && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    };
  }, [activeCycle, scopedGraph.edges, visibleNodes]);

  useEffect(() => {
    if (!isReplaying) setActiveCycle(maxCycle);
  }, [isReplaying, maxCycle]);

  useEffect(() => {
    if (!isReplaying) return;
    if (activeCycle >= maxCycle) {
      setIsReplaying(false);
      return;
    }
    const timer = window.setTimeout(() => setActiveCycle((cycle) => Math.min(maxCycle, cycle + 1)), 1300);
    return () => window.clearTimeout(timer);
  }, [activeCycle, isReplaying, maxCycle]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    selectionControlRef.current(null);
  }, []);

  const focusEgoNode = useCallback((nodeId: string) => {
    const node = visibleGraph.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    const next = { kind: "node" as const, node };
    setSelection(next);
    selectionControlRef.current(next);
    onNodeSelect?.(nodeId);
  }, [onNodeSelect, visibleGraph.nodes]);

  const openEgoNetwork = useCallback((node: SimulationGraphNode) => {
    setEgoNodeId(node.id);
  }, []);

  const togglePinnedEgo = useCallback((nodeId: string) => {
    setPinnedEgoNodeIds((current) => current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId].slice(-3));
  }, []);

  useEffect(() => {
    const frame = graphFrameRef.current;
    if (!frame) return;

    const updateDimensions = () => {
      const width = Math.max(620, Math.floor(frame.getBoundingClientRect().width || 920));
      const minimumHeight = variant === "embedded" ? 390 : 500;
      const heightRatio = variant === "embedded" ? 0.52 : 0.62;
      const height = Math.max(minimumHeight, Math.round(width * heightRatio));
      setDimensions((current) => current.width === width && current.height === height ? current : { width, height });
    };

    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [variant]);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement || !visibleGraph.nodes.length) return;

    const { width, height } = dimensions;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxRadius = Math.max(160, Math.min(width, height) * (variant === "embedded" ? 0.36 : 0.39));
    const ringRadius: Record<number, number> = {
      0: 0,
      1: maxRadius * 0.42,
      2: maxRadius * 0.72,
      3: maxRadius
    };
    const groupedNodes = new Map<number, SimulationGraphNode[]>();
    visibleGraph.nodes.forEach((node) => {
      const ring = NODE_RING[node.type] ?? 2;
      groupedNodes.set(ring, [...(groupedNodes.get(ring) || []), node]);
    });
    const nodeById = new Map<string, ForceNode>();
    const nodes: ForceNode[] = visibleGraph.nodes.map((node) => {
      const ring = NODE_RING[node.type] ?? 2;
      const peers = groupedNodes.get(ring) || [node];
      const peerIndex = Math.max(0, peers.findIndex((item) => item.id === node.id));
      const angleOffset = ring === 1 ? -Math.PI / 2 : ring === 2 ? -Math.PI / 2.7 : -Math.PI / 2.2;
      const angle = angleOffset + (peerIndex / Math.max(1, peers.length)) * Math.PI * 2;
      const radius = ringRadius[ring] || ringRadius[2];
      const forceNode: ForceNode = {
        ...node,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
      nodeById.set(forceNode.id, forceNode);
      return forceNode;
    });
    const links: ForceLink[] = visibleGraph.edges.map((edge, index) => ({
      ...edge,
      id: `${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      curve: index % 2 === 0 ? 12 : -12
    }));

    const svg = select(svgElement);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`).attr("aria-busy", isWorking ? "true" : "false");

    const definitions = svg.append("defs");
    definitions.append("marker")
      .attr("id", "legal-force-arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 17)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L9,0L0,4")
      .attr("fill", "#9ca3af");

    const viewport = svg.append("g").attr("class", "legal-force-viewport");
    const edgeLayer = viewport.append("g").attr("class", "legal-force-edges");
    const labelLayer = viewport.append("g").attr("class", "legal-force-edge-labels");
    const nodeLayer = viewport.append("g").attr("class", "legal-force-nodes");

    const pathSelection = edgeLayer.selectAll<SVGPathElement, ForceLink>("path")
      .data(links, (link) => link.id)
      .join("path")
      .attr("class", (link) => `legal-force-edge ${link.label === "conteste" ? "is-contestation" : ""}`)
      .attr("marker-end", "url(#legal-force-arrow)");

    const edgeLabelSelection = labelLayer.selectAll<SVGGElement, ForceLink>("g")
      .data(links, (link) => link.id)
      .join("g")
      .attr("class", "legal-force-edge-label")
      .style("display", showEdgeLabels ? "block" : "none");
    edgeLabelSelection.append("rect").attr("rx", 5).attr("height", 20).attr("y", -10);
    edgeLabelSelection.append("text").attr("text-anchor", "middle").attr("dy", "0.34em").text((link) => clampLabel(link.label || "relie", 24));
    edgeLabelSelection.each(function measureLabel() {
      const group = select(this);
      const text = this.querySelector("text");
      const widthForLabel = (text?.getComputedTextLength() || 26) + 14;
      group.select("rect").attr("width", widthForLabel).attr("x", -widthForLabel / 2);
    });

    const nodeSelection = nodeLayer.selectAll<SVGGElement, ForceNode>("g")
      .data(nodes, (node) => node.id)
      .join("g")
      .attr("class", (node) => {
        const expired = node.cycle_ended !== null && node.cycle_ended !== undefined && activeCycle >= node.cycle_ended;
        const contested = Number(node.refutation_count || 0) > 0;
        return `legal-force-node ${node.type} ${expired ? "is-expired" : ""} ${contested ? "is-contested" : ""}`;
      })
      .style("--force-node-color", (node) => node.type === "argument" ? EVIDENCE_META[evidenceBand(node)].color : NODE_META[node.type].color)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (node) => `${NODE_META[node.type].label}: ${node.label}`);

    nodeSelection.append("circle").attr("class", "legal-force-node-aura").attr("r", (node) => node.type === "case" ? 28 : 20);
    nodeSelection.append("circle").attr("class", "legal-force-node-core").attr("r", (node) => {
      if (node.type === "case") return 15;
      if (node.type === "argument") return 9 + Math.round(Number(node.evidence_score || 0) / 25);
      return 11;
    });
    nodeSelection.append("text").attr("class", "legal-force-node-glyph").attr("text-anchor", "middle").attr("dy", "0.34em").text((node) => NODE_META[node.type].glyph);
    nodeSelection.append("text").attr("class", "legal-force-node-label").attr("text-anchor", "middle").attr("dy", (node) => node.type === "case" ? 39 : 31).text((node) => clampLabel(node.label, node.type === "case" ? 30 : 23));
    nodeSelection.append("title").text((node) => `${NODE_META[node.type].label}: ${node.label}${node.detail ? ` - ${node.detail}` : ""}`);

    const simulation = forceSimulation<ForceNode>(nodes)
      .force("link", forceLink<ForceNode, ForceLink>(links).id((node) => node.id).distance((link) => link.label.length > 28 ? 132 : 108).strength(0.46))
      .force("charge", forceManyBody<ForceNode>().strength((node) => node.type === "case" ? -320 : -210))
      .force("center", forceCenter(centerX, centerY))
      .force("collision", forceCollide<ForceNode>().radius((node) => node.type === "case" ? 66 : 48).strength(0.94))
      .force("ring", forceRadial<ForceNode>((node) => ringRadius[NODE_RING[node.type] ?? 2] || ringRadius[2], centerX, centerY).strength(0.72))
      .force("x", forceX<ForceNode>((node) => {
        if (node.type === "case") return centerX;
        if (node.type === "actor") return centerX * 0.82;
        if (node.type === "issue") return centerX * 1.18;
        return centerX;
      }).strength(0.055))
      .force("y", forceY<ForceNode>(centerY).strength(0.04));

    const applySelection = (next: GraphSelection | null) => {
      const selectedNodeId = next?.kind === "node" ? next.node.id : null;
      const selectedEdge = next?.kind === "edge" ? next.edge : null;
      const linkedNodeIds = new Set<string>();
      if (selectedNodeId) {
        links.forEach((link) => {
          const source = endpointNode(link.source, nodeById)?.id;
          const target = endpointNode(link.target, nodeById)?.id;
          if (source === selectedNodeId || target === selectedNodeId) {
            if (source) linkedNodeIds.add(source);
            if (target) linkedNodeIds.add(target);
          }
        });
      }

      nodeSelection.classed("is-selected", (node) => node.id === selectedNodeId).classed("is-related", (node) => linkedNodeIds.has(node.id));
      pathSelection.classed("is-selected", (link) => Boolean(selectedEdge && link.source === selectedEdge.source && link.target === selectedEdge.target && link.label === selectedEdge.label))
        .classed("is-related", (link) => Boolean(selectedNodeId && (endpointNode(link.source, nodeById)?.id === selectedNodeId || endpointNode(link.target, nodeById)?.id === selectedNodeId)));
      edgeLabelSelection.classed("is-selected", (link) => Boolean(selectedEdge && link.source === selectedEdge.source && link.target === selectedEdge.target && link.label === selectedEdge.label))
        .classed("is-related", (link) => Boolean(selectedNodeId && (endpointNode(link.source, nodeById)?.id === selectedNodeId || endpointNode(link.target, nodeById)?.id === selectedNodeId)));
    };
    selectionControlRef.current = applySelection;

    nodeSelection.on("click", (event, node) => {
      event.stopPropagation();
      const next = { kind: "node" as const, node: { ...node } };
      setSelection(next);
      applySelection(next);
      onNodeSelect?.(node.id);
    }).on("keydown", (event, node) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const next = { kind: "node" as const, node: { ...node } };
      setSelection(next);
      applySelection(next);
      onNodeSelect?.(node.id);
    }).on("mouseenter", (_, node) => setHoveredNode({ ...node }))
      .on("mouseleave", () => setHoveredNode(null));
    pathSelection.on("click", (event, link) => {
      event.stopPropagation();
      const next = { kind: "edge" as const, edge: { source: String(endpointNode(link.source, nodeById)?.id || link.source), target: String(endpointNode(link.target, nodeById)?.id || link.target), label: link.label } };
      setSelection(next);
      applySelection(next);
    });
    edgeLabelSelection.on("click", (event, link) => {
      event.stopPropagation();
      const next = { kind: "edge" as const, edge: { source: String(endpointNode(link.source, nodeById)?.id || link.source), target: String(endpointNode(link.target, nodeById)?.id || link.target), label: link.label } };
      setSelection(next);
      applySelection(next);
    });

    const dragBehaviour = drag<SVGGElement, ForceNode>()
      .on("start", (event, node) => {
        if (!event.active) simulation.alphaTarget(0.28).restart();
        node.fx = node.x;
        node.fy = node.y;
      })
      .on("drag", (event, node) => {
        node.fx = event.x;
        node.fy = event.y;
      })
      .on("end", (event, node) => {
        if (!event.active) simulation.alphaTarget(0);
        node.fx = null;
        node.fy = null;
      });
    nodeSelection.call(dragBehaviour);

    const update = () => {
      pathSelection.attr("d", (link) => edgePath(link, nodeById));
      edgeLabelSelection.attr("transform", (link) => {
        const point = edgeLabelPosition(link, nodeById);
        return `translate(${point.x},${point.y})`;
      });
      nodeSelection.attr("transform", (node) => `translate(${node.x || width / 2},${node.y || height / 2})`);
    };
    simulation.on("tick", update);
    update();

    nodeSelection.style("opacity", 0).attr("transform", `translate(${width / 2},${height / 2})`)
      .transition().delay((_, index) => index * 45).duration(460).style("opacity", 1);

    const zoomBehaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 3.5])
      .on("zoom", (event) => viewport.attr("transform", event.transform.toString()));
    svg.call(zoomBehaviour).on("dblclick.zoom", null).on("click", () => clearSelection());
    resetViewRef.current = () => {
      svg.transition().duration(380).call(zoomBehaviour.transform, zoomIdentity);
      clearSelection();
    };

    return () => {
      simulation.stop();
      svg.on(".zoom", null).on("click", null);
      selectionControlRef.current = () => undefined;
    };
  }, [activeCycle, clearSelection, dimensions, isWorking, layoutVersion, onNodeSelect, showEdgeLabels, visibleGraph]);

  useEffect(() => {
    if (!focusedNodeId) return;
    const node = visibleGraph.nodes.find((item) => item.id === focusedNodeId);
    if (!node) return;
    const next = { kind: "node" as const, node };
    setSelection(next);
    selectionControlRef.current(next);
  }, [focusedNodeId, visibleGraph.nodes]);

  const toggleFullscreen = () => {
    const frame = graphFrameRef.current;
    if (!frame) return;
    if (document.fullscreenElement === frame) {
      void document.exitFullscreen();
      return;
    }
    void frame.requestFullscreen?.();
  };

  const toggleEvidenceBand = (band: EvidenceBand) => {
    setVisibleEvidenceBands((current) => {
      const next = new Set(current);
      if (next.has(band)) next.delete(band);
      else next.add(band);
      return next;
    });
  };

  const startReplay = () => {
    setActiveCycle(0);
    setIsReplaying(true);
  };

  if (!visibleGraph.nodes.length) {
    return <div className="simulation-empty-graph"><span className="material-symbols-outlined">account_tree</span><p>{isWorking ? "Le graphe juridique se construit a partir des sources et des pieces du dossier." : "Le graphe apparaitra apres la constitution du dossier."}</p></div>;
  }

  return (
    <section className={`legal-force-graph ${variant === "embedded" ? "embedded" : ""}`} ref={graphFrameRef}>
      <header className="legal-force-graph-toolbar">
        <div>
          <span className="simulation-eyebrow">{variant === "embedded" ? "Graphe vivant" : "Exploration relationnelle"}</span>
          <h2>{scope === "structure" ? "Structure juridique" : scope === "debate" ? "Debat contradictoire" : variant === "embedded" ? "Relations du dossier" : "Graphe juridique"}</h2>
          <p>{visibleGraph.nodes.length} entites et {visibleGraph.edges.length} relations. {isWorking ? "Mise a jour apres chaque intervention." : "Dernier etat consolide."}</p>
        </div>
        <div className="legal-force-graph-controls">
          <label className="legal-force-label-toggle"><input checked={showEdgeLabels} onChange={(event) => setShowEdgeLabels(event.target.checked)} type="checkbox" /><span>Liens</span></label>
          <button aria-label="Reorganiser le graphe" onClick={() => setLayoutVersion((value) => value + 1)} title="Reorganiser le graphe" type="button"><span className="material-symbols-outlined">refresh</span></button>
          <button aria-label="Recentrer le graphe" onClick={() => resetViewRef.current()} title="Recentrer le graphe" type="button"><span className="material-symbols-outlined">center_focus_strong</span></button>
          <button aria-label="Agrandir le graphe" onClick={toggleFullscreen} title="Plein ecran" type="button"><span className="material-symbols-outlined">fullscreen</span></button>
        </div>
      </header>
      <div className={`legal-force-timeline ${variant === "embedded" ? "compact" : ""}`}>
        <button aria-label="Rejouer la construction du graphe" disabled={maxCycle < 1} onClick={startReplay} type="button">
          <span className="material-symbols-outlined">replay</span>
          {variant === "full" ? "Replay" : null}
        </button>
        <label>
          <span>{activeCycle === 0 ? "Preparation" : `Cycle ${activeCycle}`}</span>
          <input aria-label="Cycle affiche" max={maxCycle} min={0} onChange={(event) => { setIsReplaying(false); setActiveCycle(Number(event.target.value)); }} step={1} type="range" value={activeCycle} />
          <small>{maxCycle ? `${activeCycle}/${maxCycle}` : "Dossier"}</small>
        </label>
        {variant === "full" ? <div className="legal-force-evidence-filters" aria-label="Filtrer les arguments par force probatoire">
          {(Object.keys(EVIDENCE_META) as EvidenceBand[]).map((band) => <button aria-pressed={visibleEvidenceBands.has(band)} className={visibleEvidenceBands.has(band) ? "active" : ""} key={band} onClick={() => toggleEvidenceBand(band)} type="button"><i style={{ backgroundColor: EVIDENCE_META[band].color }} />{EVIDENCE_META[band].label}</button>)}
        </div> : null}
      </div>
      <div className="legal-force-graph-body">
        <svg aria-label="Graphe relationnel juridique interactif" ref={svgRef} role="img" />
        <p className="legal-force-graph-hint"><span className="material-symbols-outlined">pan_tool</span> Faites glisser les entites. Molette ou pincement pour zoomer. Cliquez pour ouvrir le contexte.</p>
        {isWorking ? <div className="legal-force-graph-processing"><i /><span>Analyse des relations en cours</span></div> : null}
        <div className="legal-force-graph-legend" aria-label="Legende du graphe">
          {(Object.keys(NODE_META) as GraphNodeType[]).map((type) => <span key={type}><i style={{ backgroundColor: NODE_META[type].color }} />{NODE_META[type].label}</span>)}
        </div>
        {hoveredNode ? <div className="legal-force-hover-card" role="tooltip"><strong>{hoveredNode.label}</strong><span>{NODE_META[hoveredNode.type].label}</span>{hoveredNode.type === "argument" ? <><b style={{ color: EVIDENCE_META[evidenceBand(hoveredNode)].color }}>{Number(hoveredNode.evidence_score || 0)}/100</b><small>{Number(hoveredNode.evidence_metrics?.legal_sources || 0)} source(s), {Number(hoveredNode.evidence_metrics?.factual_exhibits || 0)} piece(s), {Number(hoveredNode.evidence_metrics?.refutations || 0)} contestation(s)</small></> : null}<button onClick={() => openEgoNetwork(hoveredNode)} type="button"><span className="material-symbols-outlined">hub</span> Ouvrir le voisinage</button></div> : null}
        {selection ? <aside className="legal-force-graph-detail" aria-live="polite">
          <button aria-label="Fermer le detail" onClick={clearSelection} type="button"><span className="material-symbols-outlined">close</span></button>
          {selection.kind === "node" ? <><span className="legal-force-detail-token" style={{ backgroundColor: selection.node.type === "argument" ? EVIDENCE_META[evidenceBand(selection.node)].color : NODE_META[selection.node.type].color }}>{NODE_META[selection.node.type].glyph}</span><small>{NODE_META[selection.node.type].label}</small><h3>{selection.node.label}</h3><p>{selection.node.detail || "Cette entite est reliee au dossier par les sources, arguments ou faits disponibles."}</p>{selection.node.type === "argument" ? <div className="legal-force-evidence-detail"><strong>Couverture probatoire: {Number(selection.node.evidence_score || 0)}/100</strong><span>{Number(selection.node.evidence_metrics?.legal_sources || 0)} source(s) juridique(s)</span><span>{Number(selection.node.evidence_metrics?.factual_exhibits || 0)} piece(s) factuelle(s)</span><span>{Number(selection.node.evidence_metrics?.refutations || 0)} contestation(s)</span><small>Ce score mesure la couverture documentaire, pas les chances de succes.</small></div> : null}<button className="legal-force-open-ego" onClick={() => openEgoNetwork(selection.node)} type="button"><span className="material-symbols-outlined">hub</span> Explorer le voisinage</button><code>{selection.node.id}</code></> : <><span className="legal-force-detail-token relation"><span className="material-symbols-outlined">arrow_forward</span></span><small>Relation</small><h3>{selection.edge.label || "Lien juridique"}</h3><p>Cette relation relie deux entites structurelles du dossier et peut etre exploree avec les noeuds associes.</p></>}
        </aside> : null}
      </div>
      {egoNodeId ? <div className="legal-force-ego-overlay" role="dialog" aria-label="Exploration du voisinage"><div className="legal-force-ego-dialog"><header><div><span className="simulation-eyebrow">Exploration contextuelle</span><h2>Voisinages du graphe</h2><p>Les liens sont calcules depuis le graphe courant, sans nouvel appel API.</p></div><button aria-label="Fermer les voisinages" onClick={() => setEgoNodeId(null)} type="button"><span className="material-symbols-outlined">close</span></button></header><div className="legal-force-ego-grid">{[egoNodeId, ...pinnedEgoNodeIds.filter((id) => id !== egoNodeId)].map((nodeId) => <EgoNetwork centerId={nodeId} graph={visibleGraph} key={nodeId} onClose={pinnedEgoNodeIds.includes(nodeId) ? undefined : () => setEgoNodeId(null)} onFocusNode={focusEgoNode} onTogglePin={togglePinnedEgo} pinned={pinnedEgoNodeIds.includes(nodeId)} />)}</div></div></div> : null}
      {variant === "full" ? <details className="legal-force-accessible-list"><summary>Explorer le graphe sous forme de liste</summary><div>{visibleGraph.nodes.map((node) => <button key={node.id} onClick={() => { const next = { kind: "node" as const, node }; setSelection(next); selectionControlRef.current(next); }} type="button"><i style={{ backgroundColor: node.type === "argument" ? EVIDENCE_META[evidenceBand(node)].color : NODE_META[node.type].color }} /><span><strong>{node.label}</strong><small>{NODE_META[node.type].label}{node.type === "argument" ? ` - ${Number(node.evidence_score || 0)}/100` : ""}</small></span></button>)}</div></details> : null}
    </section>
  );
}
