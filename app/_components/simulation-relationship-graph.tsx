"use client";

import {
  drag,
  select,
  zoom,
  zoomIdentity,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type GraphNodeType = "case" | "actor" | "issue" | "source" | "document" | "argument";
type EvidenceBand = "non_soutenu" | "faible" | "moyenne" | "forte";
type LinkDensity = "essential" | "all";

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
  actor: { label: "Personne", color: "#2563eb", glyph: "P" },
  issue: { label: "Question juridique", color: "#7c3aed", glyph: "Q" },
  source: { label: "Texte ou decision", color: "#059669", glyph: "T" },
  document: { label: "Piece du dossier", color: "#ea580c", glyph: "D" },
  argument: { label: "Argument", color: "#be123c", glyph: "A" }
};

const GRAPH_COLUMN_LABELS: Record<string, string> = {
  case: "Dossier",
  actor: "Acteurs",
  issue: "Questions de droit",
  argument: "Arguments",
  source: "Textes et decisions",
  document: "Pieces du dossier"
};

const EVIDENCE_META: Record<EvidenceBand, { label: string; color: string }> = {
  non_soutenu: { label: "Sans source", color: "#94a3b8" },
  faible: { label: "Peu etaye", color: "#dc2626" },
  moyenne: { label: "Partiellement etaye", color: "#f59e0b" },
  forte: { label: "Bien etaye", color: "#16a34a" }
};

function evidenceBand(node: SimulationGraphNode): EvidenceBand {
  if (node.evidence_band && EVIDENCE_META[node.evidence_band]) return node.evidence_band;
  const score = Number(node.evidence_score || 0);
  if (score <= 0) return "non_soutenu";
  if (score < 30) return "faible";
  if (score <= 60) return "moyenne";
  return "forte";
}

function clampLabel(value: string, length: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim() || "Element sans titre";
  return normalized.length > length
    ? `${normalized.slice(0, Math.max(1, length - 3)).trimEnd()}...`
    : normalized;
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
  const label = NODE_META[center.type]?.label || "Element";

  return (
    <section className="legal-force-ego-network" aria-label={`Voisinage de ${center.label}`}>
      <header>
        <div>
          <span className="simulation-eyebrow">Contexte local</span>
          <h3>{clampLabel(center.label, 42)}</h3>
          <p>{ego.nodes.length} elements directement ou indirectement lies</p>
        </div>
        <div className="legal-force-ego-actions">
          <button aria-pressed={pinned} onClick={() => onTogglePin(center.id)} title={pinned ? "Retirer des voisinages epingles" : "Epingler ce voisinage"} type="button">
            <span className="material-symbols-outlined">{pinned ? "push_pin" : "push_pin"}</span>
            {pinned ? "Conserve" : "Conserver"}
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
  onNodeSelect,
  onSelectionClear
}: {
  graph: SimulationGraph;
  isWorking?: boolean;
  variant?: "full" | "embedded";
  focusedNodeId?: string | null;
  scope?: "all" | "structure" | "debate";
  onNodeSelect?: (nodeId: string) => void;
  onSelectionClear?: () => void;
}) {
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const selectionControlRef = useRef<GraphSelectionControl>(() => undefined);
  const hoverClearTimerRef = useRef<number | null>(null);
  const [dimensions, setDimensions] = useState({ width: 920, height: 590 });
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [linkDensity, setLinkDensity] = useState<LinkDensity>("essential");
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

  const columnTypes = useMemo<GraphNodeType[]>(() => {
    if (scope === "structure") return ["case", "issue", "source", "document"];
    if (scope === "debate") return ["case", "actor", "issue", "argument"];
    return ["case", "actor", "issue", "argument", "source"];
  }, [scope]);

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

  const selectedNodeId = selection?.kind === "node" ? selection.node.id : null;
  const displayGraph = useMemo<SimulationGraph>(() => {
    if (linkDensity === "all") return visibleGraph;

    const nodeById = new Map(visibleGraph.nodes.map((node) => [node.id, node]));
    const columnFor = (type: GraphNodeType) => {
      const typeColumn = type === "document" && !columnTypes.includes("document") ? "source" : type;
      return Math.max(0, columnTypes.indexOf(typeColumn));
    };
    const selectedEdgeKeys = new Set<string>();
    const edgeKey = (edge: SimulationGraph["edges"][number]) => `${edge.source}|${edge.target}|${edge.label}`;

    visibleGraph.nodes.forEach((node) => {
      if (node.type === "case") return;
      const nodeColumn = columnFor(node.type);
      const candidates = visibleGraph.edges
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .sort((left, right) => {
          const leftOther = nodeById.get(left.source === node.id ? left.target : left.source);
          const rightOther = nodeById.get(right.source === node.id ? right.target : right.source);
          const leftColumn = leftOther ? columnFor(leftOther.type) : nodeColumn;
          const rightColumn = rightOther ? columnFor(rightOther.type) : nodeColumn;
          const leftPrevious = leftColumn < nodeColumn ? 0 : 1;
          const rightPrevious = rightColumn < nodeColumn ? 0 : 1;
          if (leftPrevious !== rightPrevious) return leftPrevious - rightPrevious;
          return Math.abs(nodeColumn - leftColumn) - Math.abs(nodeColumn - rightColumn);
        });
      candidates.slice(0, 1).forEach((edge) => selectedEdgeKeys.add(edgeKey(edge)));
    });

    if (selectedNodeId) {
      visibleGraph.edges
        .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
        .forEach((edge) => selectedEdgeKeys.add(edgeKey(edge)));
    }

    return {
      nodes: visibleGraph.nodes,
      edges: visibleGraph.edges.filter((edge) => selectedEdgeKeys.has(edgeKey(edge)))
    };
  }, [columnTypes, linkDensity, selectedNodeId, visibleGraph]);

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
    setHoveredNode(null);
    selectionControlRef.current(null);
    onSelectionClear?.();
  }, [onSelectionClear]);

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

  const keepHoverCard = useCallback(() => {
    if (hoverClearTimerRef.current !== null) window.clearTimeout(hoverClearTimerRef.current);
    hoverClearTimerRef.current = null;
  }, []);

  const scheduleHoverCardClose = useCallback(() => {
    keepHoverCard();
    hoverClearTimerRef.current = window.setTimeout(() => setHoveredNode(null), 180);
  }, [keepHoverCard]);

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
    const horizontalPadding = Math.min(138, Math.max(82, width * 0.085));
    const columnCount = Math.max(1, columnTypes.length);
    const columnStep = columnCount === 1 ? 0 : (width - horizontalPadding * 2) / (columnCount - 1);
    const topPadding = 76;
    const bottomPadding = 84;
    const renderedColumn = (node: SimulationGraphNode): GraphNodeType => (
      node.type === "document" && !columnTypes.includes("document") ? "source" : node.type
    );
    const groupedNodes = new Map<GraphNodeType, SimulationGraphNode[]>();
    displayGraph.nodes.forEach((node) => {
      const columnType = renderedColumn(node);
      groupedNodes.set(columnType, [...(groupedNodes.get(columnType) || []), node]);
    });
    const nodeById = new Map<string, ForceNode>();
    const nodes: ForceNode[] = displayGraph.nodes.map((node) => {
      const typeColumn = renderedColumn(node);
      const column = Math.max(0, columnTypes.indexOf(typeColumn));
      const peers = groupedNodes.get(typeColumn) || [node];
      const peerIndex = Math.max(0, peers.findIndex((item) => item.id === node.id));
      const peerStep = (height - topPadding - bottomPadding) / Math.max(1, peers.length - 1);
      const y = peers.length === 1 ? centerY : topPadding + peerIndex * peerStep;
      const forceNode: ForceNode = {
        ...node,
        x: columnCount === 1 ? centerX : horizontalPadding + column * columnStep,
        y
      };
      nodeById.set(forceNode.id, forceNode);
      return forceNode;
    });
    const links: ForceLink[] = displayGraph.edges.map((edge, index) => ({
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
    const laneLayer = viewport.append("g").attr("class", "legal-force-lanes");
    const edgeLayer = viewport.append("g").attr("class", "legal-force-edges");
    const labelLayer = viewport.append("g").attr("class", "legal-force-edge-labels");
    const nodeLayer = viewport.append("g").attr("class", "legal-force-nodes");

    const laneWidth = Math.max(112, columnStep * 0.82);
    columnTypes.forEach((type, index) => {
      const x = columnCount === 1 ? centerX : horizontalPadding + index * columnStep;
      const lane = laneLayer.append("g").attr("class", `legal-force-lane lane-${type}`);
      lane.append("rect")
        .attr("x", x - laneWidth / 2)
        .attr("y", 18)
        .attr("width", laneWidth)
        .attr("height", Math.max(90, height - 38))
        .attr("rx", 16);
      const laneLabel = type === "source" && !columnTypes.includes("document") ? "Textes et pieces" : GRAPH_COLUMN_LABELS[type];
      lane.append("text")
        .attr("x", x)
        .attr("y", 42)
        .attr("text-anchor", "middle")
        .text(laneLabel);
    });

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
    nodeSelection.append("text")
      .attr("class", "legal-force-node-label")
      .attr("text-anchor", (node) => node.type === "case" ? "start" : "middle")
      .attr("x", (node) => node.type === "case" ? 23 : 0)
      .attr("dy", (node) => node.type === "case" ? ".34em" : 31)
      .text((node) => clampLabel(node.label, node.type === "case" ? 34 : 23));
    nodeSelection.append("title").text((node) => `${NODE_META[node.type].label}: ${node.label}${node.detail ? ` - ${node.detail}` : ""}`);

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
      if (selectedEdge) {
        linkedNodeIds.add(selectedEdge.source);
        linkedNodeIds.add(selectedEdge.target);
      }

      const matchesSelectedEdge = (link: ForceLink) => Boolean(selectedEdge
        && endpointNode(link.source, nodeById)?.id === selectedEdge.source
        && endpointNode(link.target, nodeById)?.id === selectedEdge.target
        && link.label === selectedEdge.label);
      const touchesSelectedNode = (link: ForceLink) => Boolean(selectedNodeId
        && (endpointNode(link.source, nodeById)?.id === selectedNodeId || endpointNode(link.target, nodeById)?.id === selectedNodeId));
      const hasSelection = Boolean(selectedNodeId || selectedEdge);

      nodeSelection.classed("is-selected", (node) => node.id === selectedNodeId)
        .classed("is-related", (node) => linkedNodeIds.has(node.id))
        .classed("is-dimmed", (node) => hasSelection && node.id !== selectedNodeId && !linkedNodeIds.has(node.id));
      pathSelection.classed("is-selected", matchesSelectedEdge)
        .classed("is-related", touchesSelectedNode)
        .classed("is-dimmed", (link) => hasSelection && !matchesSelectedEdge(link) && !touchesSelectedNode(link));
      edgeLabelSelection.classed("is-selected", matchesSelectedEdge)
        .classed("is-related", touchesSelectedNode)
        .classed("is-dimmed", (link) => hasSelection && !matchesSelectedEdge(link) && !touchesSelectedNode(link));
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
    }).on("mouseenter", (_, node) => { keepHoverCard(); setHoveredNode({ ...node }); })
      .on("mouseleave", () => scheduleHoverCardClose());
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
      .on("start", (_, node) => { node.fx = node.x; node.fy = node.y; })
      .on("drag", (event, node) => {
        node.fx = event.x;
        node.fy = event.y;
        node.x = event.x;
        node.y = event.y;
        update();
      })
      .on("end", (_, node) => { node.fx = null; node.fy = null; });
    nodeSelection.call(dragBehaviour);

    const update = () => {
      pathSelection.attr("d", (link) => edgePath(link, nodeById));
      edgeLabelSelection.attr("transform", (link) => {
        const point = edgeLabelPosition(link, nodeById);
        return `translate(${point.x},${point.y})`;
      });
      nodeSelection.attr("transform", (node) => `translate(${node.x || width / 2},${node.y || height / 2})`);
    };
    update();

    // Polling rebuilds the SVG. Preserve the computed lane positions instead of
    // stacking every node at the center during each refresh.
    nodeSelection.style("opacity", 1);

    const zoomBehaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 3.5])
      .on("zoom", (event) => viewport.attr("transform", event.transform.toString()));
    svg.call(zoomBehaviour).on("dblclick.zoom", null).on("click", () => clearSelection());
    resetViewRef.current = () => {
      svg.transition().duration(380).call(zoomBehaviour.transform, zoomIdentity);
      clearSelection();
    };

    return () => {
      svg.on(".zoom", null).on("click", null);
      selectionControlRef.current = () => undefined;
    };
  }, [activeCycle, clearSelection, columnTypes, dimensions, displayGraph, isWorking, keepHoverCard, layoutVersion, onNodeSelect, scheduleHoverCardClose, showEdgeLabels]);

  useEffect(() => {
    selectionControlRef.current(selection);
  }, [displayGraph, selection]);

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
          <span className="simulation-eyebrow">Carte interactive</span>
          <h2>{scope === "structure" ? "Textes et pieces du dossier" : scope === "debate" ? "Personnes et arguments" : "Vue d'ensemble du dossier"}</h2>
          <p>
            {displayGraph.nodes.length} elements et {displayGraph.edges.length} liens affiches
            {linkDensity === "essential" && visibleGraph.edges.length > displayGraph.edges.length ? ` sur ${visibleGraph.edges.length}` : ""}.
            {" "}Lisez la carte de gauche a droite. {isWorking ? "Elle se complete pendant la simulation." : "Cliquez sur un element pour afficher tous ses liens directs."}
          </p>
        </div>
        <div className="legal-force-graph-controls">
          <button
            aria-label={linkDensity === "all" ? "Afficher seulement les liens essentiels" : "Afficher tous les liens"}
            aria-pressed={linkDensity === "all"}
            className="legal-force-density-control"
            onClick={() => setLinkDensity((value) => value === "all" ? "essential" : "all")}
            title={linkDensity === "all" ? "Revenir aux liens essentiels" : `Afficher les ${visibleGraph.edges.length} liens`}
            type="button"
          >
            <span className="material-symbols-outlined">{linkDensity === "all" ? "hub" : "filter_alt"}</span>
            <b>{linkDensity === "all" ? "Tous les liens" : "Liens essentiels"}</b>
          </button>
          <label className="legal-force-label-toggle" title="Afficher les mots qui expliquent chaque ligne"><input checked={showEdgeLabels} onChange={(event) => setShowEdgeLabels(event.target.checked)} type="checkbox" /><span>Expliquer les lignes</span></label>
          <button aria-label="Mieux repartir les elements" onClick={() => setLayoutVersion((value) => value + 1)} title="Mieux repartir les elements" type="button"><span className="material-symbols-outlined">refresh</span></button>
          <button aria-label="Revenir au centre" onClick={() => resetViewRef.current()} title="Revenir au centre" type="button"><span className="material-symbols-outlined">center_focus_strong</span></button>
          <button aria-label="Voir la carte en grand" onClick={toggleFullscreen} title="Voir en grand" type="button"><span className="material-symbols-outlined">fullscreen</span></button>
        </div>
      </header>
      <div className={`legal-force-timeline ${variant === "embedded" ? "compact" : ""}`}>
        <button aria-label="Rejouer la construction du graphe" disabled={maxCycle < 1} onClick={startReplay} type="button">
          <span className="material-symbols-outlined">replay</span>
          {variant === "full" ? "Revoir" : null}
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
        <p className="legal-force-graph-hint"><span className="material-symbols-outlined">touch_app</span> Lisez de gauche a droite. Cliquez sur un rond pour afficher ses liens. Deplacez un rond si besoin.</p>
        {isWorking ? <div className="legal-force-graph-processing"><i /><span>Analyse des relations en cours</span></div> : null}
        <div className="legal-force-graph-legend" aria-label="Legende du graphe">
          {(Object.keys(NODE_META) as GraphNodeType[]).map((type) => <span key={type}><i style={{ backgroundColor: NODE_META[type].color }} />{NODE_META[type].label}</span>)}
        </div>
        {hoveredNode ? <div className="legal-force-hover-card" onMouseEnter={keepHoverCard} onMouseLeave={scheduleHoverCardClose} role="tooltip"><strong>{hoveredNode.label}</strong><span>{NODE_META[hoveredNode.type].label}</span>{hoveredNode.type === "argument" ? <><b style={{ color: EVIDENCE_META[evidenceBand(hoveredNode)].color }}>{Number(hoveredNode.evidence_score || 0)}/100</b><small>{Number(hoveredNode.evidence_metrics?.legal_sources || 0)} texte(s), {Number(hoveredNode.evidence_metrics?.factual_exhibits || 0)} piece(s), {Number(hoveredNode.evidence_metrics?.refutations || 0)} contestation(s)</small></> : null}<button onClick={() => openEgoNetwork(hoveredNode)} type="button"><span className="material-symbols-outlined">hub</span> Voir les elements lies</button></div> : null}
        {selection ? <aside className="legal-force-graph-detail" aria-live="polite">
          <button aria-label="Fermer le detail" onClick={clearSelection} type="button"><span className="material-symbols-outlined">close</span></button>
          {selection.kind === "node" ? <><span className="legal-force-detail-token" style={{ backgroundColor: selection.node.type === "argument" ? EVIDENCE_META[evidenceBand(selection.node)].color : NODE_META[selection.node.type].color }}>{NODE_META[selection.node.type].glyph}</span><small>{NODE_META[selection.node.type].label}</small><h3>{selection.node.label}</h3><p>{selection.node.detail || "Cet element est relie au dossier par les textes, les arguments ou les faits disponibles."}</p>{selection.node.type === "argument" ? <div className="legal-force-evidence-detail"><strong>Niveau de soutien documentaire: {Number(selection.node.evidence_score || 0)}/100</strong><span>{Number(selection.node.evidence_metrics?.legal_sources || 0)} texte(s) juridique(s)</span><span>{Number(selection.node.evidence_metrics?.factual_exhibits || 0)} piece(s) du dossier</span><span>{Number(selection.node.evidence_metrics?.refutations || 0)} contestation(s)</span><small>Ce niveau indique les documents relies a l'argument, pas ses chances de succes.</small></div> : null}<button className="legal-force-open-ego" onClick={() => openEgoNetwork(selection.node)} type="button"><span className="material-symbols-outlined">hub</span> Voir les elements lies</button><code>{selection.node.id}</code></> : <><span className="legal-force-detail-token relation"><span className="material-symbols-outlined">arrow_forward</span></span><small>Lien entre deux elements</small><h3>{selection.edge.label || "Lien juridique"}</h3><p>Ce mot explique pourquoi les deux elements sont relies dans l'analyse du dossier.</p></>}
        </aside> : null}
      </div>
      {egoNodeId ? <div className="legal-force-ego-overlay" role="dialog" aria-label="Elements lies"><div className="legal-force-ego-dialog"><header><div><span className="simulation-eyebrow">Lecture detaillee</span><h2>Elements lies a votre selection</h2><p>Cette vue isole les liens directs et les liens proches pour eviter de surcharger la carte principale.</p></div><button aria-label="Fermer les elements lies" onClick={() => setEgoNodeId(null)} type="button"><span className="material-symbols-outlined">close</span></button></header><div className="legal-force-ego-grid">{[egoNodeId, ...pinnedEgoNodeIds.filter((id) => id !== egoNodeId)].map((nodeId) => <EgoNetwork centerId={nodeId} graph={visibleGraph} key={nodeId} onClose={pinnedEgoNodeIds.includes(nodeId) ? undefined : () => setEgoNodeId(null)} onFocusNode={focusEgoNode} onTogglePin={togglePinnedEgo} pinned={pinnedEgoNodeIds.includes(nodeId)} />)}</div></div></div> : null}
      {variant === "full" ? <details className="legal-force-accessible-list"><summary>Afficher tous les elements sous forme de liste</summary><div>{visibleGraph.nodes.map((node) => <button key={node.id} onClick={() => { const next = { kind: "node" as const, node }; setSelection(next); selectionControlRef.current(next); }} type="button"><i style={{ backgroundColor: node.type === "argument" ? EVIDENCE_META[evidenceBand(node)].color : NODE_META[node.type].color }} /><span><strong>{node.label}</strong><small>{NODE_META[node.type].label}{node.type === "argument" ? ` - ${Number(node.evidence_score || 0)}/100` : ""}</small></span></button>)}</div></details> : null}
    </section>
  );
}
