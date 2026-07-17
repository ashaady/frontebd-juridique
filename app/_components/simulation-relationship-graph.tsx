"use client";

import {
  drag,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
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

type SimulationGraphNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  detail?: string;
};

type SimulationGraph = {
  nodes: SimulationGraphNode[];
  edges: { source: string; target: string; label: string }[];
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

export function SimulationRelationshipGraph({ graph, isWorking = false }: { graph: SimulationGraph; isWorking?: boolean }) {
  const graphFrameRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const selectionControlRef = useRef<GraphSelectionControl>(() => undefined);
  const [dimensions, setDimensions] = useState({ width: 920, height: 590 });
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [selection, setSelection] = useState<GraphSelection | null>(null);

  const visibleGraph = useMemo<SimulationGraph>(() => ({
    nodes: graph.nodes.filter((node) => NODE_META[node.type]),
    edges: graph.edges.filter((edge) => graph.nodes.some((node) => node.id === edge.source) && graph.nodes.some((node) => node.id === edge.target))
  }), [graph.edges, graph.nodes]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    selectionControlRef.current(null);
  }, []);

  useEffect(() => {
    const frame = graphFrameRef.current;
    if (!frame) return;

    const updateDimensions = () => {
      const width = Math.max(620, Math.floor(frame.getBoundingClientRect().width || 920));
      const height = Math.max(500, Math.round(width * 0.62));
      setDimensions((current) => current.width === width && current.height === height ? current : { width, height });
    };

    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement || !visibleGraph.nodes.length) return;

    const { width, height } = dimensions;
    const nodeById = new Map<string, ForceNode>();
    const nodes: ForceNode[] = visibleGraph.nodes.map((node, index) => {
      const angle = (index / Math.max(1, visibleGraph.nodes.length)) * Math.PI * 2;
      const radius = Math.min(width, height) * (node.type === "case" ? 0 : 0.18 + (index % 3) * 0.045);
      const forceNode: ForceNode = {
        ...node,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius
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
      .attr("class", "legal-force-edge")
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
      .attr("class", (node) => `legal-force-node ${node.type}`)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", (node) => `${NODE_META[node.type].label}: ${node.label}`);

    nodeSelection.append("circle").attr("class", "legal-force-node-aura").attr("r", (node) => node.type === "case" ? 28 : 20);
    nodeSelection.append("circle").attr("class", "legal-force-node-core").attr("r", (node) => node.type === "case" ? 15 : 11);
    nodeSelection.append("text").attr("class", "legal-force-node-glyph").attr("text-anchor", "middle").attr("dy", "0.34em").text((node) => NODE_META[node.type].glyph);
    nodeSelection.append("text").attr("class", "legal-force-node-label").attr("text-anchor", "middle").attr("dy", (node) => node.type === "case" ? 39 : 31).text((node) => clampLabel(node.label, node.type === "case" ? 30 : 23));
    nodeSelection.append("title").text((node) => `${NODE_META[node.type].label}: ${node.label}${node.detail ? ` - ${node.detail}` : ""}`);

    const simulation = forceSimulation<ForceNode>(nodes)
      .force("link", forceLink<ForceNode, ForceLink>(links).id((node) => node.id).distance((link) => link.label.length > 28 ? 160 : 128).strength(0.74))
      .force("charge", forceManyBody().strength(-425))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collision", forceCollide<ForceNode>().radius((node) => node.type === "case" ? 73 : 56).strength(0.88))
      .force("x", forceX<ForceNode>(width / 2).strength(0.045))
      .force("y", forceY<ForceNode>(height / 2).strength(0.045));

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
      const next = { kind: "node" as const, node: { id: node.id, label: node.label, type: node.type, detail: node.detail } };
      setSelection(next);
      applySelection(next);
    }).on("keydown", (event, node) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const next = { kind: "node" as const, node: { id: node.id, label: node.label, type: node.type, detail: node.detail } };
      setSelection(next);
      applySelection(next);
    });
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
  }, [clearSelection, dimensions, isWorking, layoutVersion, showEdgeLabels, visibleGraph]);

  const toggleFullscreen = () => {
    const frame = graphFrameRef.current;
    if (!frame) return;
    if (document.fullscreenElement === frame) {
      void document.exitFullscreen();
      return;
    }
    void frame.requestFullscreen?.();
  };

  if (!visibleGraph.nodes.length) {
    return <div className="simulation-empty-graph"><span className="material-symbols-outlined">account_tree</span><p>{isWorking ? "Le graphe juridique se construit a partir des sources et des pieces du dossier." : "Le graphe apparaitra apres la constitution du dossier."}</p></div>;
  }

  return (
    <section className="legal-force-graph" ref={graphFrameRef}>
      <header className="legal-force-graph-toolbar">
        <div>
          <span className="simulation-eyebrow">Exploration relationnelle</span>
          <h2>Graphe juridique</h2>
          <p>{visibleGraph.nodes.length} entites et {visibleGraph.edges.length} relations dans le dossier.</p>
        </div>
        <div className="legal-force-graph-controls">
          <label className="legal-force-label-toggle"><input checked={showEdgeLabels} onChange={(event) => setShowEdgeLabels(event.target.checked)} type="checkbox" /><span>Liens</span></label>
          <button aria-label="Reorganiser le graphe" onClick={() => setLayoutVersion((value) => value + 1)} title="Reorganiser le graphe" type="button"><span className="material-symbols-outlined">refresh</span></button>
          <button aria-label="Recentrer le graphe" onClick={() => resetViewRef.current()} title="Recentrer le graphe" type="button"><span className="material-symbols-outlined">center_focus_strong</span></button>
          <button aria-label="Agrandir le graphe" onClick={toggleFullscreen} title="Plein ecran" type="button"><span className="material-symbols-outlined">fullscreen</span></button>
        </div>
      </header>
      <div className="legal-force-graph-body">
        <svg aria-label="Graphe relationnel juridique interactif" ref={svgRef} role="img" />
        <p className="legal-force-graph-hint"><span className="material-symbols-outlined">pan_tool</span> Faites glisser les entites. Molette ou pincement pour zoomer. Cliquez pour ouvrir le contexte.</p>
        {isWorking ? <div className="legal-force-graph-processing"><i /><span>Analyse des relations en cours</span></div> : null}
        <div className="legal-force-graph-legend" aria-label="Legende du graphe">
          {(Object.keys(NODE_META) as GraphNodeType[]).map((type) => <span key={type}><i style={{ backgroundColor: NODE_META[type].color }} />{NODE_META[type].label}</span>)}
        </div>
        {selection ? <aside className="legal-force-graph-detail" aria-live="polite">
          <button aria-label="Fermer le detail" onClick={clearSelection} type="button"><span className="material-symbols-outlined">close</span></button>
          {selection.kind === "node" ? <><span className="legal-force-detail-token" style={{ backgroundColor: NODE_META[selection.node.type].color }}>{NODE_META[selection.node.type].glyph}</span><small>{NODE_META[selection.node.type].label}</small><h3>{selection.node.label}</h3><p>{selection.node.detail || "Cette entite est reliee au dossier par les sources, arguments ou faits disponibles."}</p><code>{selection.node.id}</code></> : <><span className="legal-force-detail-token relation"><span className="material-symbols-outlined">arrow_forward</span></span><small>Relation</small><h3>{selection.edge.label || "Lien juridique"}</h3><p>Cette relation relie deux entites structurelles du dossier et peut etre exploree avec les nœuds associes.</p></>}
        </aside> : null}
      </div>
    </section>
  );
}
