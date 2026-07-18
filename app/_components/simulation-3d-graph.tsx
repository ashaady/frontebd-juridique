"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SimulationRelationshipGraph, type SimulationGraph } from "./simulation-relationship-graph";

const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

type Graph3DNode = {
  id: string;
  label: string;
  type: string;
  role?: string;
  color: string;
  layer: number;
};

type Graph3DLink = {
  source: string;
  target: string;
  label: string;
  strength: number;
};

class Simulation3DErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const COLORS: Record<string, string> = {
  case: "#e11d48",
  actor: "#2563eb",
  issue: "#7c3aed",
  source: "#059669",
  document: "#ea580c",
  argument: "#be123c"
};

function actorLayer(node: SimulationGraph["nodes"][number]): number {
  const role = String(node.detail || "").toLowerCase();
  if (role.includes("juge") || role.includes("mediat")) return 0;
  if (role.includes("defendeur") || role.includes("partie_b")) return -2;
  return 2;
}

export function Simulation3DGraph({ graph, focusedNodeId = null, onNodeSelect }: { graph: SimulationGraph; focusedNodeId?: string | null; onNodeSelect?: (nodeId: string) => void }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ width: 820, height: 560 });
  const [webglAvailable, setWebglAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    setWebglAvailable(Boolean(context));
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setDimensions({ width: Math.max(300, Math.floor(frame.clientWidth || 820)), height: Math.max(430, Math.min(680, Math.floor((frame.clientWidth || 820) * .62))) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const data = useMemo(() => {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const actorLayers = new Map(
      graph.nodes.filter((node) => node.type === "actor").map((node) => [node.id, actorLayer(node)])
    );
    const argumentLayers = new Map<string, number>();
    graph.edges.forEach((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (source?.type === "actor" && target?.type === "argument") argumentLayers.set(target.id, actorLayers.get(source.id) || 0);
      if (target?.type === "actor" && source?.type === "argument") argumentLayers.set(source.id, actorLayers.get(target.id) || 0);
    });
    const nodes = graph.nodes.map((node) => {
      const layer = node.type === "actor" ? actorLayers.get(node.id) || 0 : node.type === "argument" ? argumentLayers.get(node.id) || 0 : 1;
      return { id: node.id, label: node.label, type: node.type, role: node.detail, color: COLORS[node.type] || "#64748b", layer, fy: layer * 90 };
    });
    const links: Graph3DLink[] = graph.edges.map((edge) => {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      const argument = sourceNode?.type === "argument" ? sourceNode : targetNode?.type === "argument" ? targetNode : null;
      return { ...edge, strength: argument ? Number(argument.evidence_score || 0) : 0 };
    });
    return { nodes, links };
  }, [graph]);
  const highDensity = data.nodes.length > 200;

  const fallback = <div className="simulation-3d-fallback"><span className="material-symbols-outlined">view_in_ar</span><strong>Vue 3D indisponible</strong><p>WebGL n'est pas disponible dans ce navigateur. La vue 2D reste utilisee pour conserver l'exploration du dossier.</p><SimulationRelationshipGraph focusedNodeId={focusedNodeId} graph={graph} onNodeSelect={onNodeSelect} variant="embedded" /></div>;
  if (webglAvailable === false) return fallback;

  return (
    <section className="simulation-3d-graph" ref={frameRef} aria-label="Graphe juridique en trois dimensions">
      <header><div><span className="simulation-eyebrow">G2 / Espace spatial</span><h2>Graphe juridique 3D</h2><p>Les acteurs sont repartis par niveau : demandeur, autorite et defendeur.{highDensity ? " Le rendu haute densite reduit les effets couteux." : ""}</p></div><button onClick={() => graphRef.current?.zoomToFit?.(600, 80)} type="button"><span className="material-symbols-outlined">center_focus_strong</span> Recentrer</button></header>
      <div className="simulation-3d-canvas">
        <Simulation3DErrorBoundary fallback={fallback}>
          <ForceGraph3D ref={graphRef} backgroundColor="#f8fbf9" cooldownTicks={highDensity ? 70 : 120} d3AlphaDecay={highDensity ? .075 : .04} d3VelocityDecay={.35} graphData={data} height={dimensions.height} linkColor={() => "#a9bdb0"} linkDirectionalArrowLength={highDensity ? 0 : 4} linkDirectionalArrowRelPos={1} linkLabel={(link: Graph3DLink) => `${link.label || "Relation"}${link.strength ? ` / force ${link.strength}/100` : ""}`} linkOpacity={highDensity ? .35 : .75} linkWidth={(link: Graph3DLink) => link.label === "conteste" ? 2.5 : highDensity ? .6 : 1 + Math.min(2, link.strength / 40)} nodeColor={(node: Graph3DNode) => node.color} nodeLabel={(node: Graph3DNode) => `${node.label} / ${node.type}`} nodeRelSize={highDensity ? 3.6 : 5} nodeVal={(node: Graph3DNode) => node.type === "case" ? 3 : node.type === "argument" ? 1.8 : 1.2} onNodeClick={(node: Graph3DNode) => onNodeSelect?.(node.id)} showNavInfo={false} width={dimensions.width} />
        </Simulation3DErrorBoundary>
      </div>
      <footer><span><i style={{ background: COLORS.actor }} /> Acteurs</span><span><i style={{ background: COLORS.issue }} /> Questions</span><span><i style={{ background: COLORS.source }} /> Sources</span><span><i style={{ background: COLORS.argument }} /> Arguments</span><small>{data.nodes.length} entites / Rotation, zoom et deplacement actifs.</small></footer>
    </section>
  );
}
