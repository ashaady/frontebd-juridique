"use client";

import { useEffect, useMemo, useState } from "react";
import { SimulationRelationshipGraph, type SimulationGraph, type SimulationGraphNode } from "./simulation-relationship-graph";

type GraphChange = {
  id: string;
  label: string;
  kind: "added" | "removed" | "changed";
  nodeId?: string;
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

export function SimulationGraphComparison({
  initialGraph,
  finalGraph,
  onFocusNode
}: {
  initialGraph?: SimulationGraph;
  finalGraph: SimulationGraph;
  onFocusNode: (nodeId: string) => void;
}) {
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
    initialGraph.edges.forEach((edge) => {
      if (!afterEdges.has(edgeKey(edge))) result.push({ id: `removed-edge-${edgeKey(edge)}`, label: `${edge.label}: ${edge.source} -> ${edge.target}`, kind: "removed" });
    });
    finalGraph.edges.forEach((edge) => {
      if (!beforeEdges.has(edgeKey(edge))) result.push({ id: `added-edge-${edgeKey(edge)}`, label: `${edge.label}: ${edge.source} -> ${edge.target}`, kind: "added" });
    });
    return result;
  }, [finalGraph, initialGraph]);

  useEffect(() => {
    if (!isAnimating) return;
    const timer = window.setTimeout(() => {
      setMorphPhase(1);
      setIsAnimating(false);
    }, 950);
    return () => window.clearTimeout(timer);
  }, [isAnimating]);

  if (!initialGraph || !initialGraph.nodes.length) return null;
  const added = changes.filter((change) => change.kind === "added").length;
  const removed = changes.filter((change) => change.kind === "removed").length;
  const changed = changes.filter((change) => change.kind === "changed").length;
  const morphGraph = morphPhase === 0 ? initialGraph : finalGraph;

  return (
    <section className="simulation-graph-comparison" aria-label="Comparaison du graphe initial et final">
      <header>
        <div>
          <span className="simulation-eyebrow">Apport de la simulation</span>
          <h2>Avant / apres</h2>
          <p>Compare la structure du dossier avant les cycles avec l'etat enrichi par le debat et les nouvelles relations.</p>
        </div>
        <div className="simulation-comparison-controls">
          <button className={displayMode === "side" ? "active" : ""} onClick={() => setDisplayMode("side")} type="button">Cote a cote</button>
          <button className={displayMode === "morph" ? "active" : ""} onClick={() => setDisplayMode("morph")} type="button">Morphing</button>
          <button className="simulation-morph-button" disabled={isAnimating} onClick={() => { setDisplayMode("morph"); setMorphPhase(0); setIsAnimating(true); }} type="button"><span className="material-symbols-outlined">play_arrow</span>{isAnimating ? "Animation..." : "Animer"}</button>
        </div>
      </header>
      <div className="simulation-comparison-summary"><span className="added"><b>+{added}</b> ajouts</span><span className="removed"><b>-{removed}</b> retraits</span><span className="changed"><b>{changed}</b> evolutions</span><span><b>{initialGraph.nodes.length}</b> entites initiales</span><span><b>{finalGraph.nodes.length}</b> entites finales</span></div>
      {displayMode === "side" ? <div className="simulation-comparison-graphs"><div><h3>Etat initial</h3><SimulationRelationshipGraph graph={initialGraph} scope="all" variant="embedded" /></div><div><h3>Etat final</h3><SimulationRelationshipGraph focusedNodeId={null} graph={finalGraph} onNodeSelect={onFocusNode} scope="all" variant="embedded" /></div></div> : <div className={`simulation-comparison-morph ${isAnimating ? "is-animating" : ""}`}><h3>{morphPhase === 0 ? "Etat initial" : "Etat final"}</h3><SimulationRelationshipGraph focusedNodeId={null} graph={morphGraph} onNodeSelect={onFocusNode} scope="all" variant="embedded" /></div>}
      <div className="simulation-comparison-diff"><div><span className="simulation-eyebrow">Journal des changements</span><strong>{changes.length ? `${changes.length} difference${changes.length > 1 ? "s" : ""} detectee${changes.length > 1 ? "s" : ""}` : "Aucune difference structurelle"}</strong></div>{changes.length ? <div className="simulation-comparison-diff-list">{changes.slice(0, 24).map((change) => <button className={change.kind} key={change.id} disabled={!change.nodeId} onClick={() => change.nodeId && onFocusNode(change.nodeId)} type="button"><i>{change.kind === "added" ? "+" : change.kind === "removed" ? "-" : "~"}</i><span>{change.label}</span></button>)}</div> : null}</div>
    </section>
  );
}
