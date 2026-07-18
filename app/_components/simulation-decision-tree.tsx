"use client";

export type SimulationDecisionItem = {
  issue_id: string;
  question: string;
  status: "oui" | "non" | "indetermine";
  favorable_score: number;
  unfavorable_score: number;
  confidence: number;
  arguments_favorables: string[];
  arguments_defavorables: string[];
  arguments_neutres: string[];
  reason: string;
  cycle_updated: number;
  disclaimer: string;
};

const STATUS_META = {
  oui: { label: "Tendance favorable", icon: "thumb_up", tone: "positive" },
  non: { label: "Tendance defavorable", icon: "thumb_down", tone: "negative" },
  indetermine: { label: "Indetermine", icon: "balance", tone: "neutral" }
} as const;

export function SimulationDecisionTree({
  items,
  onFocusNode
}: {
  items: SimulationDecisionItem[];
  onFocusNode: (nodeId: string) => void;
}) {
  if (!items.length) return null;

  return (
    <section className="simulation-decision-tree" aria-labelledby="simulation-decision-title">
      <header>
        <div>
          <span className="simulation-eyebrow">Arbre de decision documentaire</span>
          <h2 id="simulation-decision-title">Questions, positions et niveau de couverture</h2>
          <p>Cette lecture compare les arguments documentes. Elle ne predit ni jugement ni chance de succes.</p>
        </div>
        <span className="material-symbols-outlined">account_tree</span>
      </header>
      <div className="simulation-decision-list">
        {items.map((item) => {
          const meta = STATUS_META[item.status];
          const branches = [
            { id: "oui", label: "Favorable", score: item.favorable_score, arguments: item.arguments_favorables },
            { id: "non", label: "Defavorable", score: item.unfavorable_score, arguments: item.arguments_defavorables },
            { id: "indetermine", label: "Neutre", score: 0, arguments: item.arguments_neutres }
          ] as const;
          return (
            <article key={item.issue_id}>
              <button className="simulation-decision-question" onClick={() => onFocusNode(item.issue_id)} type="button">
                <span className="material-symbols-outlined">help</span>
                <strong>{item.question}</strong>
                <small>Cycle {item.cycle_updated || 0}</small>
              </button>
              <div className="simulation-decision-branches">
                {branches.map((branch) => <section className={item.status === branch.id ? `active ${meta.tone}` : ""} key={branch.id}>
                  <header><span>{branch.label}</span><strong>{branch.score}</strong></header>
                  <div>{branch.arguments.length ? branch.arguments.map((argumentId) => <button key={argumentId} onClick={() => onFocusNode(argumentId)} type="button">{argumentId.replace("argument-", "")}</button>) : <small>Aucun argument classe</small>}</div>
                </section>)}
              </div>
              <footer className={meta.tone}><span className="material-symbols-outlined">{meta.icon}</span><div><strong>{meta.label}</strong><p>{item.reason}</p></div><b>{Math.round(item.confidence * 100)}%</b></footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
