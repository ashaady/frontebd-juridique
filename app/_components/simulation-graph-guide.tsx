"use client";

const GUIDE_ITEMS = [
  {
    icon: "view_column",
    title: "Structure et debat",
    text: "La structure regroupe questions, sources et pieces. Le debat montre les acteurs et arguments. Un clic synchronise toutes les vues."
  },
  {
    icon: "timeline",
    title: "Evolution par cycle",
    text: "Le curseur et Replay reconstruisent le dossier dans le temps. Les arguments eteints restent visibles en transparence."
  },
  {
    icon: "hub",
    title: "Voisinage local",
    text: "Ouvrez le contexte d'une entite pour afficher ses relations sur deux sauts, avec un maximum de vingt noeuds."
  },
  {
    icon: "balance",
    title: "Force probatoire",
    text: "La couleur des arguments combine sources, pieces et refutations. Ce score aide a lire le dossier, mais ne remplace pas une appreciation juridique."
  },
  {
    icon: "account_tree",
    title: "Decision du juge",
    text: "L'arbre expose les arguments favorables et defavorables pour chaque question, ainsi que la tendance issue des cycles."
  },
  {
    icon: "scatter_plot",
    title: "Projection semantique",
    text: "Les arguments proches utilisent des formulations ou concepts voisins. Cette projection n'est ni une preuve ni une prediction de jugement."
  }
];

export function SimulationGraphGuide() {
  return (
    <details className="simulation-graph-guide">
      <summary>
        <span className="material-symbols-outlined">help</span>
        <span><strong>Comment lire cette analyse ?</strong><small>Guide des vues, couleurs et interactions</small></span>
        <span className="material-symbols-outlined simulation-guide-chevron">expand_more</span>
      </summary>
      <div className="simulation-guide-grid">
        {GUIDE_ITEMS.map((item) => (
          <article key={item.title}>
            <span className="material-symbols-outlined">{item.icon}</span>
            <div><strong>{item.title}</strong><p>{item.text}</p></div>
          </article>
        ))}
      </div>
      <footer><span className="material-symbols-outlined">gavel</span>Les visualisations organisent les donnees de la simulation. Les sources citees restent la base de verification.</footer>
    </details>
  );
}
