"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildWorkspaceRequestHeaders } from "../_lib/workspace-api";

type SimulationKind = "trial" | "negotiation" | "mediation" | "training";
type SimulationStatus = "draft" | "preparing" | "ready" | "running" | "completed" | "stopped" | "failed" | "interrupted";

type SimulationActor = {
  id: string;
  name: string;
  role: string;
  position?: string | null;
  kind: string;
};

type SimulationSource = {
  id: string;
  chunk_id: string;
  label: string;
  citation: string;
  excerpt: string;
  page_start?: number | null;
  page_end?: number | null;
};

type SimulationAttachment = {
  id: string;
  name: string;
  size: number;
  page_count: number;
  extracted_chars: number;
  created_at: string;
};

type SimulationEvent = {
  id: string;
  sequence: number;
  type: string;
  actor_id: string;
  actor_name: string;
  content: string;
  source_ids: string[];
};

type SimulationGraphNode = {
  id: string;
  label: string;
  type: "case" | "actor" | "issue" | "source" | "document";
  detail?: string;
};

type SimulationGraph = {
  nodes: SimulationGraphNode[];
  edges: { source: string; target: string; label: string }[];
};

type SimulationReport = {
  summary: string;
  points_for: string[];
  points_against: string[];
  risks: string[];
  outcomes: string[];
  sources: string[];
  disclaimer: string;
};

type SimulationInteraction = {
  id: string;
  actor_id: string;
  actor_name: string;
  question: string;
  answer: string;
  created_at: string;
};

type SimulationCase = {
  id: string;
  title: string;
  scenario: string;
  simulation_kind: SimulationKind;
  simulation_kind_label: string;
  jurisdiction: string;
  objectives: string[];
  actors: SimulationActor[];
  attachments: SimulationAttachment[];
  issues: string[];
  sources: SimulationSource[];
  graph: SimulationGraph;
  events: SimulationEvent[];
  report: SimulationReport | null;
  interactions: SimulationInteraction[];
  retrieval: { query?: string; rewrite_status?: string; source_count?: number };
  status: SimulationStatus;
  status_message: string;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const LAST_CASE_KEY = "juridiquesn-simulation-case-id";

const STEP_ITEMS = [
  { label: "Dossier", icon: "folder_open" },
  { label: "Graphe", icon: "account_tree" },
  { label: "Acteurs", icon: "groups" },
  { label: "Audience", icon: "gavel" },
  { label: "Rapport", icon: "summarize" }
] as const;

const KIND_OPTIONS: { id: SimulationKind; title: string; detail: string; icon: string }[] = [
  { id: "trial", title: "Audience", detail: "Debat contradictoire et issue motivee", icon: "gavel" },
  { id: "negotiation", title: "Negociation", detail: "Interets, propositions et concessions", icon: "handshake" },
  { id: "mediation", title: "Mediation", detail: "Dialogue guide sans decision imposee", icon: "diversity_3" },
  { id: "training", title: "Cas pratique", detail: "Entrainement pour etudiants et praticiens", icon: "school" }
];

const EVENT_META: Record<string, { label: string; icon: string; tone: string }> = {
  opening: { label: "Ouverture", icon: "play_arrow", tone: "blue" },
  submission: { label: "Conclusions", icon: "description", tone: "indigo" },
  response: { label: "Reponse", icon: "reply", tone: "orange" },
  question: { label: "Question", icon: "help", tone: "amber" },
  rebuttal: { label: "Replique", icon: "swap_horiz", tone: "pink" },
  deliberation: { label: "Delibere", icon: "psychology", tone: "violet" },
  ruling: { label: "Issue", icon: "balance", tone: "green" },
  argument: { label: "Argument", icon: "format_quote", tone: "slate" }
};

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("fr-SN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "Taille inconnue";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} Ko`;
  return `${(size / (1024 * 1024)).toFixed(1).replace(".0", "")} Mo`;
}

function trimLabel(value: string, max = 38): string {
  return value.length > max ? `${value.slice(0, max - 1).trim()}...` : value;
}

function graphPosition(node: SimulationGraphNode, index: number, total: number): { x: number; y: number } {
  if (node.type === "case") return { x: 390, y: 225 };
  const rows: Record<SimulationGraphNode["type"], { x: number; y: number; distance: number }> = {
    actor: { x: 112, y: 82, distance: 104 },
    source: { x: 668, y: 82, distance: 90 },
    document: { x: 668, y: 365, distance: 74 },
    issue: { x: 390, y: 390, distance: 108 },
    case: { x: 390, y: 225, distance: 1 }
  };
  const group = rows[node.type];
  const itemCount = Math.max(1, total);
  const offset = (index - (itemCount - 1) / 2) * group.distance;
  return node.type === "issue" ? { x: group.x + offset, y: group.y } : { x: group.x, y: group.y + offset };
}

function SimulationGraphView({ graph }: { graph: SimulationGraph }) {
  const positions = useMemo(() => {
    const grouped: Record<SimulationGraphNode["type"], SimulationGraphNode[]> = { case: [], actor: [], source: [], document: [], issue: [] };
    graph.nodes.forEach((node) => grouped[node.type].push(node));
    const result = new Map<string, { x: number; y: number }>();
    (Object.keys(grouped) as SimulationGraphNode["type"][]).forEach((kind) => {
      grouped[kind].forEach((node, index) => result.set(node.id, graphPosition(node, index, grouped[kind].length)));
    });
    return result;
  }, [graph]);

  if (!graph.nodes.length) {
    return <div className="simulation-empty-graph"><span className="material-symbols-outlined">account_tree</span><p>Le graphe apparaitra apres la constitution du dossier.</p></div>;
  }

  return (
    <div className="simulation-graph-canvas">
      <svg aria-label="Graphe des relations juridiques" role="img" viewBox="0 0 780 470">
        <defs>
          <filter id="simulation-node-shadow" x="-30%" y="-40%" width="160%" height="180%">
            <feDropShadow dx="0" dy="6" floodColor="#0f172a" floodOpacity="0.12" stdDeviation="5" />
          </filter>
        </defs>
        {graph.edges.map((edge, index) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          return <line className="simulation-graph-edge" key={`${edge.source}-${edge.target}-${index}`} x1={source.x} x2={target.x} y1={source.y} y2={target.y} />;
        })}
        {graph.nodes.map((node) => {
          const point = positions.get(node.id);
          if (!point) return null;
          const width = node.type === "case" ? 168 : node.type === "source" ? 150 : 142;
          const height = node.type === "case" ? 70 : 58;
          return (
            <g className={`simulation-graph-node ${node.type}`} filter="url(#simulation-node-shadow)" key={node.id} transform={`translate(${point.x - width / 2} ${point.y - height / 2})`}>
              <rect height={height} rx="12" width={width} />
              <text className="simulation-graph-node-label" textAnchor="middle" x={width / 2} y={height / 2 - 5}>{trimLabel(node.label, node.type === "case" ? 28 : 22)}</text>
              <text className="simulation-graph-node-detail" textAnchor="middle" x={width / 2} y={height / 2 + 14}>{trimLabel(node.detail || node.type, 24)}</text>
            </g>
          );
        })}
      </svg>
      <div className="simulation-graph-legend">
        <span><i className="case" />Dossier</span><span><i className="actor" />Acteur</span><span><i className="issue" />Question</span><span><i className="source" />Source</span><span><i className="document" />Piece PDF</span>
      </div>
    </div>
  );
}

export function SimulationWorkspace() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [cases, setCases] = useState<SimulationCase[]>([]);
  const [caseData, setCaseData] = useState<SimulationCase | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [title, setTitle] = useState("");
  const [scenario, setScenario] = useState("");
  const [kind, setKind] = useState<SimulationKind>("trial");
  const [jurisdiction, setJurisdiction] = useState("Senegal");
  const [objective, setObjective] = useState("");
  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isUploadingPdf, setIsUploadingPdf] = useState(false);
  const [error, setError] = useState("");
  const [interactionQuestion, setInteractionQuestion] = useState("");
  const [selectedActorId, setSelectedActorId] = useState("");
  const [interactionBusy, setInteractionBusy] = useState(false);

  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getToken();
    const headers = buildWorkspaceRequestHeaders(init?.headers, true);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store", ...init, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(payload?.detail || `Erreur serveur (${response.status}).`);
    }
    return response.json() as Promise<T>;
  }, [getToken]);

  const uploadPdf = useCallback(async (caseId: string, file: File): Promise<SimulationCase> => {
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      throw new Error("Selectionnez un fichier PDF.");
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new Error("Le PDF depasse la taille maximale de 20 Mo.");
    }
    const token = await getToken();
    const headers = buildWorkspaceRequestHeaders(undefined, false);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const formData = new FormData();
    formData.append("file", file, file.name);
    const response = await fetch(`${BACKEND_URL}/simulation/cases/${caseId}/documents`, {
      method: "POST",
      cache: "no-store",
      headers,
      body: formData
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(payload?.detail || `Import du PDF impossible (${response.status}).`);
    }
    return response.json() as Promise<SimulationCase>;
  }, [getToken]);

  const downloadPdf = useCallback(async (attachment: SimulationAttachment) => {
    if (!caseData) return;
    try {
      const token = await getToken();
      const headers = buildWorkspaceRequestHeaders(undefined, false);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${BACKEND_URL}/simulation/cases/${caseData.id}/documents/${attachment.id}`, { headers });
      if (!response.ok) throw new Error("Le PDF n'est plus disponible.");
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Telechargement du PDF impossible.");
    }
  }, [caseData, getToken]);

  const refreshCases = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const response = await request<{ items: SimulationCase[] }>("/simulation/cases");
      setCases(response.items || []);
      const storedId = window.localStorage.getItem(LAST_CASE_KEY);
      const preferred = response.items.find((item) => item.id === storedId) || response.items[0];
      if (preferred && !caseData) setCaseData(preferred);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de charger les simulations.");
    }
  }, [caseData, isSignedIn, request]);

  useEffect(() => {
    if (isLoaded && isSignedIn) void refreshCases();
  }, [isLoaded, isSignedIn, refreshCases]);

  const refreshCase = useCallback(async (caseId = caseData?.id) => {
    if (!caseId) return;
    try {
      const next = await request<SimulationCase>(`/simulation/cases/${caseId}`);
      setCaseData(next);
      window.localStorage.setItem(LAST_CASE_KEY, next.id);
      setCases((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      if (next.actors.length && !selectedActorId) setSelectedActorId(next.actors[0].id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de charger le dossier.");
    }
  }, [caseData?.id, request, selectedActorId]);

  useEffect(() => {
    if (!caseData || !["preparing", "running"].includes(caseData.status)) return;
    const timer = window.setInterval(() => void refreshCase(caseData.id), 1300);
    return () => window.clearInterval(timer);
  }, [caseData?.id, caseData?.status, refreshCase]);

  const createCase = async () => {
    if (scenario.trim().length < 20) {
      setError("Decrivez les faits avec au moins 20 caracteres pour constituer le dossier.");
      return;
    }
    setIsBusy(true);
    setError("");
    try {
      const created = await request<SimulationCase>("/simulation/cases", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim() || undefined,
          scenario: scenario.trim(),
          simulation_kind: kind,
          jurisdiction: jurisdiction.trim() || "Senegal",
          objectives: objective.trim() ? [objective.trim()] : []
        })
      });
      let dossier = created;
      if (pendingPdf) {
        setIsUploadingPdf(true);
        dossier = await uploadPdf(created.id, pendingPdf);
        setPendingPdf(null);
        setIsUploadingPdf(false);
      }
      setCaseData(dossier);
      setCases((current) => [dossier, ...current.filter((item) => item.id !== dossier.id)]);
      window.localStorage.setItem(LAST_CASE_KEY, dossier.id);
      setActiveStep(0);
      await request<SimulationCase>(`/simulation/cases/${dossier.id}/prepare`, { method: "POST" });
      await refreshCase(dossier.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Creation de la simulation impossible.");
    } finally {
      setIsUploadingPdf(false);
      setIsBusy(false);
    }
  };

  const addPdfToCase = async (file: File | null) => {
    if (!caseData || !file) return;
    setIsUploadingPdf(true);
    setError("");
    try {
      const next = await uploadPdf(caseData.id, file);
      setCaseData(next);
      setCases((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      setActiveStep(0);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Import du PDF impossible.");
    } finally {
      setIsUploadingPdf(false);
    }
  };

  const prepareCase = async () => {
    if (!caseData) return;
    setIsBusy(true);
    setError("");
    try {
      await request<SimulationCase>(`/simulation/cases/${caseData.id}/prepare`, { method: "POST" });
      await refreshCase(caseData.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Preparation impossible.");
    } finally {
      setIsBusy(false);
    }
  };

  const runCase = async () => {
    if (!caseData) return;
    setIsBusy(true);
    setError("");
    try {
      await request<SimulationCase>(`/simulation/cases/${caseData.id}/run`, { method: "POST" });
      setActiveStep(3);
      await refreshCase(caseData.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Demarrage de l'audience impossible.");
    } finally {
      setIsBusy(false);
    }
  };

  const stopCase = async () => {
    if (!caseData) return;
    try {
      await request<SimulationCase>(`/simulation/cases/${caseData.id}/stop`, { method: "POST" });
      await refreshCase(caseData.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Arret impossible.");
    }
  };

  const askActor = async () => {
    if (!caseData || !selectedActorId || interactionQuestion.trim().length < 2) return;
    setInteractionBusy(true);
    setError("");
    try {
      await request<SimulationInteraction>(`/simulation/cases/${caseData.id}/interactions`, {
        method: "POST",
        body: JSON.stringify({ actor_id: selectedActorId, question: interactionQuestion.trim() })
      });
      setInteractionQuestion("");
      await refreshCase(caseData.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "L'acteur ne peut pas repondre.");
    } finally {
      setInteractionBusy(false);
    }
  };

  const isWorking = caseData?.status === "preparing" || caseData?.status === "running";
  const selectedActor = caseData?.actors.find((actor) => actor.id === selectedActorId);

  if (!isLoaded) {
    return <main className="simulation-loading"><span className="material-symbols-outlined">autorenew</span> Chargement de la simulation...</main>;
  }

  if (!isSignedIn) {
    return (
      <main className="simulation-auth-gate">
        <span className="material-symbols-outlined">lock</span>
        <h1>Simulation juridique</h1>
        <p>Connectez-vous pour creer et conserver vos dossiers de simulation.</p>
        <Link href="/sign-in">Se connecter</Link>
      </main>
    );
  }

  return (
    <main className="simulation-shell">
      <header className="simulation-topbar">
        <div className="simulation-brand">
          <Link aria-label="Retour au chat Juridique SN" className="simulation-brand-mark" href="/">
            <span className="material-symbols-outlined filled">gavel</span>
          </Link>
          <div>
            <p>Juridique SN</p>
            <strong>Simulation juridique</strong>
          </div>
        </div>
        <div className="simulation-topbar-status"><i className={isWorking ? "working" : ""} /> Corpus RAG relie au dossier</div>
        <Link className="simulation-return" href="/"><span className="material-symbols-outlined">arrow_back</span> Retour au chat</Link>
      </header>

      <section className="simulation-stepper" aria-label="Etapes de simulation">
        {STEP_ITEMS.map((step, index) => {
          const disabled = !caseData && index > 0;
          return (
            <button className={`${activeStep === index ? "active" : ""} ${index < activeStep ? "done" : ""}`} disabled={disabled} key={step.label} onClick={() => setActiveStep(index)} type="button">
              <span>{index < activeStep ? <span className="material-symbols-outlined">check</span> : index + 1}</span>
              <em className="material-symbols-outlined">{step.icon}</em>
              <strong>{step.label}</strong>
            </button>
          );
        })}
      </section>

      {error ? <div className="simulation-alert"><span className="material-symbols-outlined">error</span><p>{error}</p><button onClick={() => setError("")} type="button"><span className="material-symbols-outlined">close</span></button></div> : null}

      {!caseData ? (
        <section className="simulation-new-case">
          <div className="simulation-intro">
            <span className="simulation-eyebrow">Moteur de scenario</span>
            <h1>Construisez un dossier,<br />pas une simple reponse.</h1>
            <p>Le corpus juridique est transforme en pieces, questions de droit, roles et debats contradictoires. La simulation reste explicitement hypothetique.</p>
            <div className="simulation-intro-points"><span><i />Sources du RAG</span><span><i />Acteurs contradictoires</span><span><i />Rapport structure</span></div>
          </div>
          <div className="simulation-create-card">
            <div className="simulation-create-heading"><span className="material-symbols-outlined">add_circle</span><div><h2>Nouveau scenario</h2><p>Les faits guident la recherche documentaire et les echanges.</p></div></div>
            <label className="simulation-field"><span>Titre du dossier <small>Optionnel</small></span><input onChange={(event) => setTitle(event.target.value)} placeholder="Ex. Litige relatif a un bail commercial" value={title} /></label>
            <span className="simulation-field-label">Format de simulation</span>
            <div className="simulation-kind-grid">
              {KIND_OPTIONS.map((option) => <button className={kind === option.id ? "selected" : ""} key={option.id} onClick={() => setKind(option.id)} type="button"><span className="material-symbols-outlined">{option.icon}</span><strong>{option.title}</strong><small>{option.detail}</small></button>)}
            </div>
            <label className="simulation-field"><span>Faits, contexte et demandes</span><textarea onChange={(event) => setScenario(event.target.value)} placeholder="Decrivez la situation, les parties, les faits, les dates utiles et ce que chaque partie demande..." rows={8} value={scenario} /></label>
            <div className="simulation-upload-field">
              <div><span>Piece PDF <small>Optionnel</small></span><p>Contrat, requete, courrier ou autre element factuel prive. Il ne sera pas ajoute au corpus juridique.</p></div>
              <label className="simulation-upload-control">
                <span className="material-symbols-outlined">upload_file</span>
                <strong>{pendingPdf ? pendingPdf.name : "Ajouter un PDF"}</strong>
                <small>{pendingPdf ? formatFileSize(pendingPdf.size) : "20 Mo maximum"}</small>
                <input accept="application/pdf,.pdf" onChange={(event) => setPendingPdf(event.target.files?.[0] || null)} type="file" />
              </label>
            </div>
            <div className="simulation-create-row"><label className="simulation-field"><span>Juridiction ou cadre</span><input onChange={(event) => setJurisdiction(event.target.value)} value={jurisdiction} /></label><label className="simulation-field"><span>Objectif <small>Optionnel</small></span><input onChange={(event) => setObjective(event.target.value)} placeholder="Ex. preparer une plaidoirie" value={objective} /></label></div>
            <button className="simulation-primary-action" disabled={isBusy || scenario.trim().length < 20} onClick={() => void createCase()} type="button"><span className={`material-symbols-outlined ${isBusy ? "spin" : ""}`}>{isBusy ? "autorenew" : "auto_awesome"}</span>{isBusy ? (isUploadingPdf ? "Import du PDF..." : "Constitution en cours...") : "Constituer le dossier"}</button>
          </div>
        </section>
      ) : (
        <section className="simulation-workbench">
          <aside className="simulation-left-rail">
            <div className="simulation-case-heading"><span className="material-symbols-outlined">folder</span><div><small>Dossier actif</small><strong>{caseData.title}</strong></div></div>
            <div className={`simulation-status ${caseData.status}`}><i /><div><strong>{caseData.status === "completed" ? "Simulation terminee" : caseData.status_message}</strong><small>{caseData.simulation_kind_label} · {caseData.jurisdiction}</small></div></div>
            <div className="simulation-rail-actions">
              <label className={`simulation-attachment-action ${isWorking || isUploadingPdf ? "disabled" : ""}`}>
                <span className={`material-symbols-outlined ${isUploadingPdf ? "spin" : ""}`}>{isUploadingPdf ? "autorenew" : "attach_file"}</span>{isUploadingPdf ? "Import en cours..." : "Ajouter une piece PDF"}
                <input accept="application/pdf,.pdf" disabled={isWorking || isUploadingPdf} onChange={(event) => { const file = event.target.files?.[0] || null; event.currentTarget.value = ""; void addPdfToCase(file); }} type="file" />
              </label>
              {["draft", "stopped", "failed", "interrupted"].includes(caseData.status) ? <button onClick={() => void prepareCase()} type="button"><span className="material-symbols-outlined">find_in_page</span> Preparer le dossier</button> : null}
              {caseData.status === "ready" ? <button className="run" onClick={() => void runCase()} type="button"><span className="material-symbols-outlined">play_arrow</span> Lancer l'audience</button> : null}
              {isWorking ? <button className="stop" onClick={() => void stopCase()} type="button"><span className="material-symbols-outlined">stop_circle</span> Arreter</button> : null}
              <button onClick={() => { setCaseData(null); window.localStorage.removeItem(LAST_CASE_KEY); }} type="button"><span className="material-symbols-outlined">add</span> Nouveau scenario</button>
            </div>
            <div className="simulation-rail-section"><div className="simulation-rail-section-title"><span>Questions de droit</span><b>{caseData.issues.length}</b></div>{caseData.issues.length ? <ul className="simulation-issues">{caseData.issues.map((issue) => <li key={issue}><span className="material-symbols-outlined">trip_origin</span>{issue}</li>)}</ul> : <p className="simulation-empty-copy">En attente de la constitution du dossier.</p>}</div>
            <div className="simulation-rail-section simulation-recent-section"><div className="simulation-rail-section-title"><span>Simulations recentes</span><b>{cases.length}</b></div><div className="simulation-recent-list">{cases.slice(0, 5).map((item) => <button className={item.id === caseData.id ? "selected" : ""} key={item.id} onClick={() => { setCaseData(item); setActiveStep(item.report ? 4 : 0); window.localStorage.setItem(LAST_CASE_KEY, item.id); }} type="button"><strong>{item.title}</strong><small>{formatDate(item.updated_at)}</small></button>)}</div></div>
          </aside>

          <div className="simulation-main-panel">
            {activeStep === 0 ? (
              <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 1</span><h1>Dossier probatoire</h1><p>La recherche est executee dans le corpus avant tout debat entre les acteurs.</p></div><span className="material-symbols-outlined stage-icon">folder_open</span></div><div className="simulation-facts-card"><span>FAITS DECLARES</span><p>{caseData.scenario}</p><div><i>Requete de recherche</i><code>{caseData.retrieval.query || "Preparation en attente"}</code></div></div><section className="simulation-attachment-list"><div className="simulation-attachment-heading"><div><span className="simulation-eyebrow">Pieces jointes</span><h2>Elements factuels prives</h2></div><span>{caseData.attachments.length} PDF</span></div>{caseData.attachments.length ? caseData.attachments.map((attachment) => <article key={attachment.id}><span className="material-symbols-outlined">picture_as_pdf</span><div><strong>{attachment.name}</strong><small>{attachment.page_count} page{attachment.page_count > 1 ? "s" : ""} · {formatFileSize(attachment.size)} · Texte extrait</small></div><button onClick={() => void downloadPdf(attachment)} title={`Telecharger ${attachment.name}`} type="button"><span className="material-symbols-outlined">download</span></button></article>) : <p>Aucune piece jointe. Vous pouvez ajouter un PDF depuis les actions du dossier.</p>}</section><div className="simulation-source-list">{caseData.sources.length ? caseData.sources.map((source) => <article key={source.id}><div className="simulation-source-token">{source.id}</div><div><strong>{source.label}</strong><small>{source.citation}</small><p>{source.excerpt}</p></div><span className="material-symbols-outlined">menu_book</span></article>) : <div className="simulation-panel-empty"><span className="material-symbols-outlined">manage_search</span><p>{isWorking ? "Recherche documentaire en cours..." : "Aucune source disponible. Relancez la preparation du dossier."}</p></div>}</div></div>
            ) : null}

            {activeStep === 1 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 2</span><h1>Carte des relations</h1><p>Les liens montrent les acteurs, les questions juridiques et les passages qui structurent le scenario.</p></div><span className="material-symbols-outlined stage-icon">account_tree</span></div><SimulationGraphView graph={caseData.graph} /></div> : null}

            {activeStep === 2 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 3</span><h1>Acteurs de la simulation</h1><p>Chaque role reste borne par les faits declares et les extraits du dossier.</p></div><span className="material-symbols-outlined stage-icon">groups</span></div><div className="simulation-actor-grid">{caseData.actors.map((actor) => <article key={actor.id}><div className="simulation-avatar">{actor.name.slice(0, 1).toUpperCase()}</div><div><span>{actor.kind === "institutional" ? "ROLE INSTITUTIONNEL" : "PARTIE"}</span><h3>{actor.name}</h3><b>{actor.role.replaceAll("_", " ")}</b><p>{actor.position || "Intervient dans le dossier selon son role procedurale."}</p></div></article>)}</div></div> : null}

            {activeStep === 3 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 4</span><h1>Audience simulee</h1><p>Un scenario contradictoire. Les conclusions sont hypothetique et ne valent pas decision de justice.</p></div><span className="material-symbols-outlined stage-icon">gavel</span></div>{caseData.status === "ready" ? <div className="simulation-run-ready"><span className="material-symbols-outlined">record_voice_over</span><h2>Le dossier est pret a etre entendu.</h2><p>Les sources sont figees pour cette simulation. Lancez l'audience afin de produire les positions, replique et delibere.</p><button className="simulation-primary-action" onClick={() => void runCase()} type="button"><span className="material-symbols-outlined">play_arrow</span>Lancer l'audience</button></div> : null}{caseData.status === "running" ? <div className="simulation-running"><span className="material-symbols-outlined spin">autorenew</span><strong>Les acteurs examinent le dossier...</strong><p>La timeline apparaitra des que l'orchestration est terminee.</p></div> : null}<div className="simulation-timeline">{caseData.events.map((event) => { const meta = EVENT_META[event.type] || EVENT_META.argument; return <article key={event.id}><div className={`simulation-timeline-icon ${meta.tone}`}><span className="material-symbols-outlined">{meta.icon}</span></div><div className="simulation-timeline-content"><div><span>{meta.label}</span><strong>{event.actor_name}</strong></div><p>{event.content}</p>{event.source_ids.length ? <footer>{event.source_ids.map((sourceId) => <b key={sourceId}>{sourceId}</b>)}</footer> : null}</div></article>; })}</div></div> : null}

            {activeStep === 4 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 5</span><h1>Rapport et echanges</h1><p>Restitution exploitable pour une preparation, une formation ou une analyse strategique.</p></div><span className="material-symbols-outlined stage-icon">summarize</span></div>{caseData.report ? <div className="simulation-report"><section className="simulation-report-summary"><span className="material-symbols-outlined">auto_awesome</span><div><small>SYNTHESE</small><p>{caseData.report.summary}</p></div></section><div className="simulation-report-grid"><section><h3><span className="material-symbols-outlined">add_task</span> Points a soutenir</h3>{caseData.report.points_for.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">warning</span> Points de vigilance</h3>{caseData.report.points_against.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">shield</span> Risques</h3>{caseData.report.risks.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">alt_route</span> Issues possibles</h3>{caseData.report.outcomes.map((item) => <p key={item}>{item}</p>)}</section></div><aside className="simulation-disclaimer"><span className="material-symbols-outlined">info</span>{caseData.report.disclaimer}</aside></div> : <div className="simulation-panel-empty"><span className="material-symbols-outlined">summarize</span><p>Le rapport sera disponible a la fin de l'audience simulee.</p></div>}<section className="simulation-interaction"><div className="simulation-interaction-heading"><div><span className="simulation-eyebrow">Interroger un acteur</span><h2>Tester un argument ou une position</h2></div><select onChange={(event) => setSelectedActorId(event.target.value)} value={selectedActorId}>{caseData.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name} · {actor.role.replaceAll("_", " ")}</option>)}</select></div>{caseData.interactions.map((interaction) => <div className="simulation-chat-pair" key={interaction.id}><div className="user"><b>Vous</b><p>{interaction.question}</p></div><div className="actor"><b>{interaction.actor_name}</b><p>{interaction.answer}</p></div></div>)}<div className="simulation-chat-input"><textarea disabled={!caseData.sources.length || interactionBusy} onChange={(event) => setInteractionQuestion(event.target.value)} placeholder={selectedActor ? `Questionner ${selectedActor.name}...` : "Choisissez un acteur..."} rows={2} value={interactionQuestion} /><button disabled={!caseData.sources.length || interactionBusy || interactionQuestion.trim().length < 2} onClick={() => void askActor()} type="button"><span className={`material-symbols-outlined ${interactionBusy ? "spin" : ""}`}>{interactionBusy ? "autorenew" : "north"}</span></button></div></section></div> : null}
          </div>
        </section>
      )}
    </main>
  );
}
