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

type SimulationGraphNode = {
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

type SimulationGraph = {
  nodes: SimulationGraphNode[];
  edges: { source: string; target: string; label: string; cycle_created?: number }[];
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

export function SimulationRelationshipGraph({
  graph,
  isWorking = false,
  variant = "full",
  focusedNodeId = null
}: {
  graph: SimulationGraph;
  isWorking?: boolean;
  variant?: "full" | "embedded";
  focusedNodeId?: string | null;
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
  const [activeCycle, setActiveCycle] = useState(0);
  const [isReplaying, setIsReplaying] = useState(false);
  const [visibleEvidenceBands, setVisibleEvidenceBands] = useState<Set<EvidenceBand>>(
    () => new Set(Object.keys(EVIDENCE_META) as EvidenceBand[])
  );

  const maxCycle = useMemo(() => Math.max(
    0,
    ...graph.nodes.map((node) => Number(node.cycle_created || 0)),
    ...graph.edges.map((edge) => Number(edge.cycle_created || 0))
  ), [graph.edges, graph.nodes]);

  const visibleNodes = useMemo(() => graph.nodes.filter((node) => {
      if (!NODE_META[node.type] || Number(node.cycle_created || 0) > activeCycle) return false;
      return node.type !== "argument" || visibleEvidenceBands.has(evidenceBand(node));
    }), [activeCycle, graph.nodes, visibleEvidenceBands]);

  const visibleGraph = useMemo<SimulationGraph>(() => {
    const nodeIds = new Set(visibleNodes.map((node) => node.id));
    return {
      nodes: visibleNodes,
      edges: graph.edges.filter((edge) => Number(edge.cycle_created || 0) <= activeCycle && nodeIds.has(edge.source) && nodeIds.has(edge.target))
    };
  }, [activeCycle, graph.edges, visibleNodes]);

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
    }).on("keydown", (event, node) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const next = { kind: "node" as const, node: { ...node } };
      setSelection(next);
      applySelection(next);
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
  }, [activeCycle, clearSelection, dimensions, isWorking, layoutVersion, showEdgeLabels, visibleGraph]);

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
          <h2>{variant === "embedded" ? "Relations du dossier" : "Graphe juridique"}</h2>
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
        {hoveredNode ? <div className="legal-force-hover-card" role="tooltip"><strong>{hoveredNode.label}</strong><span>{NODE_META[hoveredNode.type].label}</span>{hoveredNode.type === "argument" ? <><b style={{ color: EVIDENCE_META[evidenceBand(hoveredNode)].color }}>{Number(hoveredNode.evidence_score || 0)}/100</b><small>{Number(hoveredNode.evidence_metrics?.legal_sources || 0)} source(s), {Number(hoveredNode.evidence_metrics?.factual_exhibits || 0)} piece(s), {Number(hoveredNode.evidence_metrics?.refutations || 0)} contestation(s)</small></> : null}</div> : null}
        {selection ? <aside className="legal-force-graph-detail" aria-live="polite">
          <button aria-label="Fermer le detail" onClick={clearSelection} type="button"><span className="material-symbols-outlined">close</span></button>
          {selection.kind === "node" ? <><span className="legal-force-detail-token" style={{ backgroundColor: selection.node.type === "argument" ? EVIDENCE_META[evidenceBand(selection.node)].color : NODE_META[selection.node.type].color }}>{NODE_META[selection.node.type].glyph}</span><small>{NODE_META[selection.node.type].label}</small><h3>{selection.node.label}</h3><p>{selection.node.detail || "Cette entite est reliee au dossier par les sources, arguments ou faits disponibles."}</p>{selection.node.type === "argument" ? <div className="legal-force-evidence-detail"><strong>Couverture probatoire: {Number(selection.node.evidence_score || 0)}/100</strong><span>{Number(selection.node.evidence_metrics?.legal_sources || 0)} source(s) juridique(s)</span><span>{Number(selection.node.evidence_metrics?.factual_exhibits || 0)} piece(s) factuelle(s)</span><span>{Number(selection.node.evidence_metrics?.refutations || 0)} contestation(s)</span><small>Ce score mesure la couverture documentaire, pas les chances de succes.</small></div> : null}<code>{selection.node.id}</code></> : <><span className="legal-force-detail-token relation"><span className="material-symbols-outlined">arrow_forward</span></span><small>Relation</small><h3>{selection.edge.label || "Lien juridique"}</h3><p>Cette relation relie deux entites structurelles du dossier et peut etre exploree avec les noeuds associes.</p></>}
        </aside> : null}
      </div>
      {variant === "full" ? <details className="legal-force-accessible-list"><summary>Explorer le graphe sous forme de liste</summary><div>{visibleGraph.nodes.map((node) => <button key={node.id} onClick={() => { const next = { kind: "node" as const, node }; setSelection(next); selectionControlRef.current(next); }} type="button"><i style={{ backgroundColor: node.type === "argument" ? EVIDENCE_META[evidenceBand(node)].color : NODE_META[node.type].color }} /><span><strong>{node.label}</strong><small>{NODE_META[node.type].label}{node.type === "argument" ? ` - ${Number(node.evidence_score || 0)}/100` : ""}</small></span></button>)}</div></details> : null}
    </section>
  );
}
