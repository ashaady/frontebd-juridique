"use client";

import { useEffect, useMemo, useState } from "react";
import { SimulationRelationshipGraph, type SimulationGraph, type SimulationGraphNode } from "./simulation-relationship-graph";

type GraphChange = {
  id: string;
  label: string;
  kind: "added" | "removed" | "changed";
  nodeId?: string;
};

type MorphNode = {
  id: string;
  before?: SimulationGraphNode;
  after?: SimulationGraphNode;
  x: number;
  y: number;
};

const NODE_COLORS: Record<SimulationGraphNode["type"], string> = {
  case: "#e11d48",
  actor: "#2563eb",
  issue: "#7c3aed",
  source: "#059669",
  document: "#ea580c",
  argument: "#be123c"
};

function edgeKey(edge: SimulationGraph["edges"][number]): string {
  return `${edge.source}|${edge.target}|${edge.label}`;
}

function nodeChanged(before: SimulationGraphNode, after: SimulationGraphNode): boolean {
  return before.label !== after.label
    || before.detail !== after.detail
    || before.evidence_score !== after.evidence_score
    || before.evidence_band !== after.evidence_band
    || before.cycle_ended !== after.cycle_ended
    || before.refutation_count !== after.refutation_count;
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function deterministicPosition(node: SimulationGraphNode): { x: number; y: number } {
  if (node.type === "case") return { x: 360, y: 190 };
  const ringByType: Record<SimulationGraphNode["type"], number> = { case: 0, actor: 95, issue: 145, source: 205, document: 225, argument: 275 };
  const radius = ringByType[node.type];
  const angle = (hashNumber(node.id) % 3600) / 3600 * Math.PI * 2;
  return { x: 360 + Math.cos(angle) * radius, y: 190 + Math.sin(angle) * radius * .58 };
}

function argumentColor(node: SimulationGraphNode): string {
  if (node.type !== "argument") return NODE_COLORS[node.type];
  const score = Number(node.evidence_score || 0);
  if (!node.evidence_score) return "#94a3b8";
  if (score < 30) return "#dc2626";
  if (score <= 60) return "#f59e0b";
  return "#16a34a";
}

function nodeRadius(node: SimulationGraphNode): number {
  if (node.type === "case") return 15;
  if (node.type === "argument") return 7 + Math.min(7, Math.round(Number(node.evidence_score || 0) / 18));
  return node.type === "actor" ? 11 : 9;
}

function MorphGraph({ initialGraph, finalGraph, progress, onFocusNode }: { initialGraph: SimulationGraph; finalGraph: SimulationGraph; progress: 0 | 1; onFocusNode: (nodeId: string) => void }) {
  const data = useMemo(() => {
    const beforeById = new Map(initialGraph.nodes.map((node) => [node.id, node]));
    const afterById = new Map(finalGraph.nodes.map((node) => [node.id, node]));
    const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];
    const nodes: MorphNode[] = ids.map((id) => {
      const before = beforeById.get(id);
      const after = afterById.get(id);
      return { id, before, after, ...deterministicPosition(after || before as SimulationGraphNode) };
    });
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const beforeEdges = new Map(initialGraph.edges.map((edge) => [edgeKey(edge), edge]));
    const afterEdges = new Map(finalGraph.edges.map((edge) => [edgeKey(edge), edge]));
    const edgeKeys = [...new Set([...beforeEdges.keys(), ...afterEdges.keys()])];
    const edges = edgeKeys.map((key) => ({ key, before: beforeEdges.get(key), after: afterEdges.get(key) }));
    return { nodes, nodeById, edges };
  }, [finalGraph, initialGraph]);

  return (
    <div className={`simulation-morph-preview progress-${progress}`}>
      <svg aria-label={progress ? "Etat final du graphe" : "Etat initial du graphe"} role="img" viewBox="0 0 720 380">
        <defs><marker id="simulation-morph-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3"><path d="M0,0 L6,3 L0,6 z" fill="#a8b9ad" /></marker></defs>
        <g className="simulation-morph-links">
          {data.edges.map((item) => {
            const edge = item.after || item.before;
            if (!edge) return null;
            const source = data.nodeById.get(edge.source);
            const target = data.nodeById.get(edge.target);
            if (!source || !target) return null;
            const isAdded = !item.before;
            const isRemoved = !item.after;
            const opacity = isAdded ? progress : isRemoved ? 1 - progress : .42;
            return <line key={item.key} markerEnd="url(#simulation-morph-arrow)" opacity={opacity} x1={source.x} x2={target.x} y1={source.y} y2={target.y} />;
          })}
        </g>
        <g className="simulation-morph-nodes">
          {data.nodes.map((item) => {
            const node = progress ? item.after || item.before : item.before || item.after;
            if (!node) return null;
            const isAdded = !item.before;
            const isRemoved = !item.after;
            const opacity = isAdded ? progress : isRemoved ? 1 - progress : 1;
            const changed = Boolean(item.before && item.after && nodeChanged(item.before, item.after));
            return <g className={`${isAdded ? "added" : isRemoved ? "removed" : changed ? "changed" : "stable"}`} key={item.id} onClick={() => onFocusNode(item.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onFocusNode(item.id); } }} opacity={opacity} role="button" tabIndex={0} transform={`translate(${item.x},${item.y})`}><circle fill={argumentColor(node)} r={nodeRadius(node)} /><text dy={nodeRadius(node) + 12} textAnchor="middle">{node.label.length > 24 ? `${node.label.slice(0, 23)}...` : node.label}</text><title>{node.label}</title></g>;
          })}
        </g>
      </svg>
      <div className="simulation-morph-progress"><i style={{ width: `${progress * 100}%` }} /><span>{progress ? "Etat enrichi" : "Etat initial"}</span></div>
    </div>
  );
}

export function SimulationGraphComparison({ initialGraph, finalGraph, onFocusNode }: { initialGraph?: SimulationGraph; finalGraph: SimulationGraph; onFocusNode: (nodeId: string) => void }) {
  const [displayMode, setDisplayMode] = useState<"side" | "morph">("side");
  const [morphPhase, setMorphPhase] = useState<0 | 1>(1);
  const [isAnimating, setIsAnimating] = useState(false);

  const changes = useMemo<GraphChange[]>(() => {
    if (!initialGraph) return [];
    const beforeNodes = new Map(initialGraph.nodes.map((node) => [node.id, node]));
    const afterNodes = new Map(finalGraph.nodes.map((node) => [node.id, node]));
    const result: GraphChange[] = [];
    beforeNodes.forEach((node, id) => {
      const after = afterNodes.get(id);
      if (!after) result.push({ id: `removed-node-${id}`, label: node.label, kind: "removed", nodeId: id });
      else if (nodeChanged(node, after)) result.push({ id: `changed-node-${id}`, label: node.label, kind: "changed", nodeId: id });
    });
    afterNodes.forEach((node, id) => {
      if (!beforeNodes.has(id)) result.push({ id: `added-node-${id}`, label: node.label, kind: "added", nodeId: id });
    });
    const beforeEdges = new Set(initialGraph.edges.map(edgeKey));
    const afterEdges = new Set(finalGraph.edges.map(edgeKey));
    initialGraph.edges.forEach((edge) => { if (!afterEdges.has(edgeKey(edge))) result.push({ id: `removed-edge-${edgeKey(edge)}`, label: `${edge.label}: ${edge.source} -> ${edge.target}`, kind: "removed" }); });
    finalGraph.edges.forEach((edge) => { if (!beforeEdges.has(edgeKey(edge))) result.push({ id: `added-edge-${edgeKey(edge)}`, label: `${edge.label}: ${edge.source} -> ${edge.target}`, kind: "added" }); });
    return result;
  }, [finalGraph, initialGraph]);

  useEffect(() => {
    if (!isAnimating) return;
    setMorphPhase(0);
    const startTimer = window.setTimeout(() => setMorphPhase(1), 120);
    const endTimer = window.setTimeout(() => setIsAnimating(false), 1700);
    return () => { window.clearTimeout(startTimer); window.clearTimeout(endTimer); };
  }, [isAnimating]);

  if (!initialGraph || !initialGraph.nodes.length) return null;
  const added = changes.filter((change) => change.kind === "added").length;
  const removed = changes.filter((change) => change.kind === "removed").length;
  const changed = changes.filter((change) => change.kind === "changed").length;

  return (
    <section className="simulation-graph-comparison" aria-label="Comparaison du graphe initial et final">
      <header><div><span className="simulation-eyebrow">Apport de la simulation</span><h2>Avant / apres</h2><p>Compare la structure du dossier avant les cycles avec l'etat enrichi par le debat et les nouvelles relations.</p></div><div className="simulation-comparison-controls"><button className={displayMode === "side" ? "active" : ""} onClick={() => setDisplayMode("side")} type="button">Cote a cote</button><button className={displayMode === "morph" ? "active" : ""} onClick={() => setDisplayMode("morph")} type="button">Morphing</button><button className="simulation-morph-button" disabled={isAnimating} onClick={() => { setDisplayMode("morph"); setIsAnimating(true); }} type="button"><span className="material-symbols-outlined">play_arrow</span>{isAnimating ? "Animation..." : "Animer"}</button></div></header>
      <div className="simulation-comparison-summary"><span className="added"><b>+{added}</b> ajouts</span><span className="removed"><b>-{removed}</b> retraits</span><span className="changed"><b>{changed}</b> evolutions</span><span><b>{initialGraph.nodes.length}</b> entites initiales</span><span><b>{finalGraph.nodes.length}</b> entites finales</span></div>
      {displayMode === "side" ? <div className="simulation-comparison-graphs"><div><h3>Etat initial</h3><SimulationRelationshipGraph graph={initialGraph} scope="all" variant="embedded" /></div><div><h3>Etat final</h3><SimulationRelationshipGraph focusedNodeId={null} graph={finalGraph} onNodeSelect={onFocusNode} scope="all" variant="embedded" /></div></div> : <div className={`simulation-comparison-morph ${isAnimating ? "is-animating" : ""}`}><h3>Transition structurelle</h3><MorphGraph finalGraph={finalGraph} initialGraph={initialGraph} onFocusNode={onFocusNode} progress={morphPhase} /></div>}
      <div className="simulation-comparison-diff"><div><span className="simulation-eyebrow">Journal des changements</span><strong>{changes.length ? `${changes.length} difference${changes.length > 1 ? "s" : ""} detectee${changes.length > 1 ? "s" : ""}` : "Aucune difference structurelle"}</strong></div>{changes.length ? <div className="simulation-comparison-diff-list">{changes.slice(0, 24).map((change) => <button className={change.kind} key={change.id} disabled={!change.nodeId} onClick={() => change.nodeId && onFocusNode(change.nodeId)} type="button"><i>{change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~"}</i><span>{change.label}</span></button>)}</div> : null}</div>
    </section>
  );
}
