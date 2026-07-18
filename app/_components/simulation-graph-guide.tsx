"use client";

type GraphGuideProps = {
  graph: {
    nodes: { type: string }[];
    edges: unknown[];
  };
};

const GUIDE_ITEMS = [
  {
    icon: "groups",
    title: "Personnes et arguments",
    text: "La vue Debat isole les personnes qui interviennent et les arguments qu'elles avancent."
  },
  {
    icon: "menu_book",
    title: "Textes et pieces",
    text: "La vue Sources isole les questions juridiques, les textes retrouves et les PDF du dossier."
  },
  {
    icon: "timeline",
    title: "Evolution de l'analyse",
    text: "Le curseur des cycles permet de revoir quand chaque element est apparu pendant la simulation."
  },
  {
    icon: "verified",
    title: "Arguments plus ou moins etayes",
    text: "La couleur d'un argument indique combien de textes, de pieces et de contestations lui sont relies."
  },
  {
    icon: "account_tree",
    title: "Questions a trancher",
    text: "L'analyse avancee regroupe, pour chaque question, les arguments favorables et defavorables."
  },
  {
    icon: "scatter_plot",
    title: "Notions proches",
    text: "La projection avancee rapproche les arguments qui utilisent des notions similaires. Ce n'est pas une prediction."
  }
];

export function SimulationGraphGuide({ graph }: GraphGuideProps) {
  const count = (type: string) => graph.nodes.filter((node) => node.type === type).length;
  const people = count("actor");
  const questions = count("issue");
  const documents = count("source") + count("document");
  const argumentsCount = count("argument");

  return (
    <section className="simulation-graph-onboarding" aria-labelledby="simulation-graph-reading-title">
      <header>
        <span className="material-symbols-outlined">map</span>
        <div>
          <span className="simulation-eyebrow">Lecture guidee</span>
          <h2 id="simulation-graph-reading-title">Comment lire cette carte ?</h2>
          <p>Chaque rond represente un element du dossier. Une ligne signifie que deux elements sont lies dans l'analyse.</p>
        </div>
      </header>

      <div className="simulation-graph-reading-steps">
        <article><b>1</b><i className="case" /><div><strong>Commencez au centre</strong><p>Le rond rose represente votre dossier.</p></div></article>
        <article><b>2</b><i className="actor" /><div><strong>Identifiez les personnes</strong><p>Les ronds bleus sont les participants.</p></div></article>
        <article><b>3</b><i className="issue" /><div><strong>Reperez les questions</strong><p>Les ronds violets sont les points de droit a resoudre.</p></div></article>
        <article><b>4</b><i className="source" /><div><strong>Verifiez ce qui les soutient</strong><p>Vert : texte juridique. Orange : piece PDF. Rouge fonce : argument.</p></div></article>
      </div>

      <div className="simulation-graph-summary" aria-label="Resume du contenu de la carte">
        <span><b>{people}</b> personne{people > 1 ? "s" : ""}</span>
        <span><b>{questions}</b> question{questions > 1 ? "s" : ""}</span>
        <span><b>{documents}</b> texte{documents > 1 ? "s ou pieces" : " ou piece"}</span>
        <span><b>{argumentsCount}</b> argument{argumentsCount > 1 ? "s" : ""}</span>
        <span><b>{graph.edges.length}</b> lien{graph.edges.length > 1 ? "s" : ""}</span>
      </div>

      <p className="simulation-graph-click-hint"><span className="material-symbols-outlined">touch_app</span>Cliquez sur un rond pour afficher son explication et les elements qui lui sont lies.</p>

      <details className="simulation-graph-guide">
        <summary>
          <span className="material-symbols-outlined">help</span>
          <span><strong>Besoin de plus de details ?</strong><small>Comprendre les vues et les analyses avancees</small></span>
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
        <footer><span className="material-symbols-outlined">gavel</span>La carte aide a organiser le dossier. Les textes cites restent la base a verifier.</footer>
      </details>
    </section>
  );
}
