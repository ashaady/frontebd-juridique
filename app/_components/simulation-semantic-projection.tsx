"use client";

import { useMemo, useState } from "react";

export type SemanticProjectionPoint = {
  id: string;
  label: string;
  claim: string;
  x: number;
  y: number;
  evidence_score: number;
  evidence_band: "non_soutenu" | "faible" | "moyenne" | "forte" | string;
  actor_name?: string;
  cycle_created?: number;
};

export type SemanticProjection = {
  case_id: string;
  requested_method: string;
  method: string;
  warning?: string | null;
  points: SemanticProjectionPoint[];
  links: { source: string; target: string; label: string }[];
  embedding_model?: string | null;
  cached?: boolean;
};

const COLORS: Record<string, string> = {
  non_soutenu: "#94a3b8",
  faible: "#dc2626",
  moyenne: "#f59e0b",
  forte: "#16a34a"
};

function pointColor(point: SemanticProjectionPoint): string {
  return COLORS[point.evidence_band] || COLORS.non_soutenu;
}

function clampLabel(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, Math.max(1, length - 1)).trim()}...` : value;
}

export function SimulationSemanticProjection({ projection, onFocusNode }: { projection: SemanticProjection; onFocusNode: (nodeId: string) => void }) {
  const [scale, setScale] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const pointById = useMemo(() => new Map(projection.points.map((point) => [point.id, point])), [projection.points]);
  const positions = useMemo(() => new Map(projection.points.map((point) => [point.id, { x: 36 + point.x * 648, y: 32 + (1 - point.y) * 286 }])), [projection.points]);
  const highlightedIds = useMemo(() => {
    if (!selectedIds.length) return new Set<string>();
    const ids = new Set<string>(selectedIds);
    projection.links.forEach((link) => {
      if (ids.has(link.source)) ids.add(link.target);
      if (ids.has(link.target)) ids.add(link.source);
    });
    return ids;
  }, [projection.links, selectedIds]);
  const hovered = hoveredId ? pointById.get(hoveredId) : null;

  const togglePoint = (pointId: string) => {
    setSelectedIds((current) => current.includes(pointId) ? current.filter((id) => id !== pointId) : [...current, pointId]);
    onFocusNode(pointId);
  };

  return (
    <section className="simulation-semantic-projection" aria-label="Projection semantique des arguments">
      <header>
        <div>
          <span className="simulation-eyebrow">Espace semantique</span>
          <h2>Projection des arguments</h2>
          <p>Les points proches representent des arguments dont les embeddings sont semantiquement similaires.</p>
        </div>
        <div className="simulation-projection-controls">
          <span className="simulation-projection-engine">{projection.method.toUpperCase()}{projection.cached ? " / cache" : " / calcule"}</span>
          {selectedIds.length ? <button aria-label="Effacer la selection" className="simulation-projection-clear" onClick={() => setSelectedIds([])} title="Effacer la selection" type="button"><span className="material-symbols-outlined">deselect</span></button> : null}
          <button aria-label="Reduire le zoom" onClick={() => setScale((value) => Math.max(.7, value - .15))} type="button">-</button>
          <button aria-label="Reinitialiser le zoom" onClick={() => setScale(1)} type="button"><span className="material-symbols-outlined">center_focus_strong</span></button>
          <button aria-label="Augmenter le zoom" onClick={() => setScale((value) => Math.min(2.3, value + .15))} type="button">+</button>
        </div>
      </header>
      {projection.warning ? <div className="simulation-projection-warning"><span className="material-symbols-outlined">info</span>{projection.warning}</div> : null}
      <div className="simulation-projection-canvas">
        <svg aria-label="Nuage de points des arguments" onWheel={(event) => { event.preventDefault(); setScale((value) => Math.min(2.3, Math.max(.7, value + (event.deltaY < 0 ? .1 : -.1)))); }} role="img" viewBox="0 0 720 330">
          <g transform={`translate(${360 - 360 * scale} ${165 - 165 * scale}) scale(${scale})`}>
            <line className="simulation-projection-axis" x1="36" x2="684" y1="318" y2="318" />
            <line className="simulation-projection-axis" x1="36" x2="36" y1="18" y2="318" />
            <g className="simulation-projection-links">
              {projection.links.map((link, index) => {
                const source = positions.get(link.source);
                const target = positions.get(link.target);
                if (!source || !target) return null;
                const visible = !selectedIds.length || highlightedIds.has(link.source) || highlightedIds.has(link.target);
                return <line className={visible ? "visible" : "faded"} key={`${link.source}-${link.target}-${index}`} x1={source.x} x2={target.x} y1={source.y} y2={target.y} />;
              })}
            </g>
            <g className="simulation-projection-points">
              {projection.points.map((point) => {
                const position = positions.get(point.id);
                if (!position) return null;
                const selected = selectedIds.includes(point.id);
                const highlighted = !selectedIds.length || highlightedIds.has(point.id);
                return <g aria-pressed={selected} className={`simulation-projection-point ${highlighted ? "highlighted" : "faded"} ${selected ? "selected" : ""}`} key={point.id} onClick={() => togglePoint(point.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); togglePoint(point.id); } }} onMouseEnter={() => setHoveredId(point.id)} onMouseLeave={() => setHoveredId(null)} role="button" tabIndex={0} transform={`translate(${position.x},${position.y})`}><circle fill={pointColor(point)} r={5 + Math.round(point.evidence_score / 35)} /><title>{`${point.claim} - ${point.evidence_score}/100`}</title></g>;
              })}
            </g>
          </g>
        </svg>
        {hovered ? <div className="simulation-projection-tooltip" role="tooltip"><strong>{clampLabel(hovered.claim, 100)}</strong><span>{hovered.actor_name || "Argument"} / {hovered.evidence_score}/100</span><small>Cliquez pour ajouter ou retirer cet argument de la selection.</small></div> : null}
      </div>
      <footer><span><i style={{ background: COLORS.non_soutenu }} /> Non soutenu</span><span><i style={{ background: COLORS.faible }} /> Faible</span><span><i style={{ background: COLORS.moyenne }} /> Moyenne</span><span><i style={{ background: COLORS.forte }} /> Forte</span><small>{projection.points.length} argument(s){selectedIds.length ? ` / ${selectedIds.length} selectionne(s)` : ""} / Modele: {projection.embedding_model || "RAG"}</small></footer>
    </section>
  );
}
