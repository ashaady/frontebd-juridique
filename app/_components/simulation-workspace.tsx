"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildWorkspaceRequestHeaders } from "../_lib/workspace-api";
import { SimulationRelationshipGraph } from "./simulation-relationship-graph";

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
  argument_ids?: string[];
};

type SimulationGraphNode = {
  id: string;
  label: string;
  type: "case" | "actor" | "issue" | "source" | "document" | "argument";
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
  source_ids?: string[];
  attachment_ids?: string[];
  created_at: string;
};

type SimulationArgument = {
  id: string;
  stage: string;
  actor_id: string;
  actor_name: string;
  claim: string;
  explanation?: string;
  source_ids: string[];
  attachment_ids: string[];
  issue_ids: string[];
  support_status: "documente" | "piece_sans_base_legale" | "non_soutenu" | string;
  strength: "forte" | "moyenne" | "faible" | "non_soutenu" | string;
};

type SimulationSourceAnalysis = {
  assessments: { source_id: string; kind?: string; stance: string; ratio?: string; summary: string }[];
  divergences: string[];
  limitations: string[];
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
  agent_memories: Record<string, { actor_id: string; actor_name: string; role: string; content: string; argument_ids: string[] }>;
  arguments: SimulationArgument[];
  source_analysis: SimulationSourceAnalysis;
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
  source_review: { label: "Analyse des sources", icon: "fact_check", tone: "teal" },
  risk_assessment: { label: "Analyse de risques", icon: "shield", tone: "red" },
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

function ArgumentEvidenceList({ arguments: argumentsList, sourceAnalysis }: { arguments: SimulationArgument[]; sourceAnalysis: SimulationSourceAnalysis }) {
  const sourceAssessments = sourceAnalysis.assessments.slice(0, 6);
  const visibleArguments = argumentsList.slice(0, 18);

  if (!sourceAssessments.length && !visibleArguments.length) return null;

  return (
    <section className="simulation-argument-evidence">
      <header>
        <div>
          <span className="simulation-eyebrow">Controle documentaire</span>
          <h2>Sources et arguments de la simulation</h2>
          <p>La couverture indique seulement si un argument est reliÃ© aux sources ou piÃ¨ces du dossier. Elle ne prÃ©juge pas de sa validitÃ© juridique.</p>
        </div>
        <span className="material-symbols-outlined">verified</span>
      </header>
      {sourceAssessments.length ? (
        <div className="simulation-source-assessments">
          {sourceAssessments.map((assessment) => <article key={`${assessment.source_id}-${assessment.summary}`}><b>{assessment.source_id}</b><div><strong>{[assessment.kind, assessment.stance].filter(Boolean).join(" · ").replaceAll("_", " ")}</strong><p>{assessment.summary}{assessment.ratio ? ` Portee: ${assessment.ratio}` : ""}</p></div></article>)}
        </div>
      ) : null}
      {visibleArguments.length ? (
        <div className="simulation-argument-list">
          {visibleArguments.map((argument) => <article className={argument.support_status} key={argument.id}>
            <div className="simulation-argument-heading"><strong>{argument.actor_name}</strong><span>{argument.support_status.replaceAll("_", " ")}</span></div>
            <p>{argument.claim}</p>
            {argument.explanation ? <small>{argument.explanation}</small> : null}
            <footer>{argument.source_ids.map((sourceId) => <b key={sourceId}>{sourceId}</b>)}{argument.attachment_ids.length ? <i>PiÃ¨ce privÃ©e</i> : null}{!argument.source_ids.length && !argument.attachment_ids.length ? <i>Sans rÃ©fÃ©rence dÃ©clarÃ©e</i> : null}</footer>
          </article>)}
        </div>
      ) : null}
    </section>
  );
}

export function SimulationWorkspace() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [cases, setCases] = useState<SimulationCase[]>([]);
  const [caseData, setCaseData] = useState<SimulationCase | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
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
      if (preferred && !caseData && !isCreatingNew) setCaseData(preferred);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de charger les simulations.");
    }
  }, [caseData, isCreatingNew, isSignedIn, request]);

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
      setIsCreatingNew(false);
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

  const beginNewCase = () => {
    setCaseData(null);
    setIsCreatingNew(true);
    setActiveStep(0);
    setTitle("");
    setScenario("");
    setKind("trial");
    setJurisdiction("Senegal");
    setObjective("");
    setPendingPdf(null);
    setSelectedActorId("");
    setInteractionQuestion("");
    setError("");
    window.localStorage.removeItem(LAST_CASE_KEY);
  };

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
            <div className={`simulation-status ${caseData.status}`}><i /><div><strong>{caseData.status === "completed" ? "Simulation terminee" : caseData.status_message}</strong><small>{caseData.simulation_kind_label} Â· {caseData.jurisdiction}</small></div></div>
            <div className="simulation-rail-actions">
              <label className={`simulation-attachment-action ${isWorking || isUploadingPdf ? "disabled" : ""}`}>
                <span className={`material-symbols-outlined ${isUploadingPdf ? "spin" : ""}`}>{isUploadingPdf ? "autorenew" : "attach_file"}</span>{isUploadingPdf ? "Import en cours..." : "Ajouter une piece PDF"}
                <input accept="application/pdf,.pdf" disabled={isWorking || isUploadingPdf} onChange={(event) => { const file = event.target.files?.[0] || null; event.currentTarget.value = ""; void addPdfToCase(file); }} type="file" />
              </label>
              {["draft", "stopped", "failed", "interrupted"].includes(caseData.status) ? <button onClick={() => void prepareCase()} type="button"><span className="material-symbols-outlined">find_in_page</span> Preparer le dossier</button> : null}
              {caseData.status === "ready" ? <button className="run" onClick={() => void runCase()} type="button"><span className="material-symbols-outlined">play_arrow</span> Lancer l'audience</button> : null}
              {isWorking ? <button className="stop" onClick={() => void stopCase()} type="button"><span className="material-symbols-outlined">stop_circle</span> Arreter</button> : null}
              <button onClick={beginNewCase} type="button"><span className="material-symbols-outlined">add</span> Nouveau scenario</button>
            </div>
            <div className="simulation-rail-section"><div className="simulation-rail-section-title"><span>Questions de droit</span><b>{caseData.issues.length}</b></div>{caseData.issues.length ? <ul className="simulation-issues">{caseData.issues.map((issue) => <li key={issue}><span className="material-symbols-outlined">trip_origin</span>{issue}</li>)}</ul> : <p className="simulation-empty-copy">En attente de la constitution du dossier.</p>}</div>
            <div className="simulation-rail-section simulation-recent-section"><div className="simulation-rail-section-title"><span>Simulations recentes</span><b>{cases.length}</b></div><div className="simulation-recent-list">{cases.slice(0, 5).map((item) => <button className={item.id === caseData.id ? "selected" : ""} key={item.id} onClick={() => { setCaseData(item); setIsCreatingNew(false); setActiveStep(item.report ? 4 : 0); window.localStorage.setItem(LAST_CASE_KEY, item.id); }} type="button"><strong>{item.title}</strong><small>{formatDate(item.updated_at)}</small></button>)}</div></div>
          </aside>

          <div className="simulation-main-panel">
            <div className={activeStep >= 2 ? "simulation-stage-layout has-live-graph" : "simulation-stage-layout"}>
              <div className="simulation-stage-layout-content">
            {activeStep === 0 ? (
              <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 1</span><h1>Dossier probatoire</h1><p>La recherche est executee dans le corpus avant tout debat entre les acteurs.</p></div><span className="material-symbols-outlined stage-icon">folder_open</span></div><div className="simulation-facts-card"><span>FAITS DECLARES</span><p>{caseData.scenario}</p><div><i>Requete de recherche</i><code>{caseData.retrieval.query || "Preparation en attente"}</code></div></div><section className="simulation-attachment-list"><div className="simulation-attachment-heading"><div><span className="simulation-eyebrow">Pieces jointes</span><h2>Elements factuels prives</h2></div><span>{caseData.attachments.length} PDF</span></div>{caseData.attachments.length ? caseData.attachments.map((attachment) => <article key={attachment.id}><span className="material-symbols-outlined">picture_as_pdf</span><div><strong>{attachment.name}</strong><small>{attachment.page_count} page{attachment.page_count > 1 ? "s" : ""} Â· {formatFileSize(attachment.size)} Â· Texte extrait</small></div><button onClick={() => void downloadPdf(attachment)} title={`Telecharger ${attachment.name}`} type="button"><span className="material-symbols-outlined">download</span></button></article>) : <p>Aucune piece jointe. Vous pouvez ajouter un PDF depuis les actions du dossier.</p>}</section><div className="simulation-source-list">{caseData.sources.length ? caseData.sources.map((source) => <article key={source.id}><div className="simulation-source-token">{source.id}</div><div><strong>{source.label}</strong><small>{source.citation}</small><p>{source.excerpt}</p></div><span className="material-symbols-outlined">menu_book</span></article>) : <div className="simulation-panel-empty"><span className="material-symbols-outlined">manage_search</span><p>{isWorking ? "Recherche documentaire en cours..." : "Aucune source disponible. Relancez la preparation du dossier."}</p></div>}</div></div>
            ) : null}

            {activeStep === 1 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 2</span><h1>Carte des relations</h1><p>Les liens montrent les acteurs, les questions juridiques et les passages qui structurent le scenario.</p></div><span className="material-symbols-outlined stage-icon">account_tree</span></div><SimulationRelationshipGraph graph={caseData.graph} isWorking={isWorking} /></div> : null}

            {activeStep === 2 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 3</span><h1>Acteurs de la simulation</h1><p>Chaque role reste borne par les faits declares et les extraits du dossier.</p></div><span className="material-symbols-outlined stage-icon">groups</span></div><div className="simulation-actor-grid">{caseData.actors.map((actor) => <article key={actor.id}><div className="simulation-avatar">{actor.name.slice(0, 1).toUpperCase()}</div><div><span>{actor.kind === "institutional" ? "ROLE INSTITUTIONNEL" : "PARTIE"}</span><h3>{actor.name}</h3><b>{actor.role.replaceAll("_", " ")}</b><p>{actor.position || "Intervient dans le dossier selon son role procedurale."}</p></div></article>)}</div></div> : null}

            {activeStep === 3 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 4</span><h1>Audience simulee</h1><p>Un scenario contradictoire. Les conclusions sont hypothetique et ne valent pas decision de justice.</p></div><span className="material-symbols-outlined stage-icon">gavel</span></div>{caseData.status === "ready" ? <div className="simulation-run-ready"><span className="material-symbols-outlined">record_voice_over</span><h2>Le dossier est pret a etre entendu.</h2><p>Les sources sont figees pour cette simulation. Lancez l'audience afin de produire les positions, replique et delibere.</p><button className="simulation-primary-action" onClick={() => void runCase()} type="button"><span className="material-symbols-outlined">play_arrow</span>Lancer l'audience</button></div> : null}{caseData.status === "running" ? <div className="simulation-running"><span className="material-symbols-outlined spin">autorenew</span><strong>Les acteurs examinent le dossier...</strong><p>Les memoires et leurs sources apparaissent apres chaque etape terminee.</p></div> : null}<div className="simulation-timeline">{caseData.events.map((event) => { const meta = EVENT_META[event.type] || EVENT_META.argument; return <article key={event.id}><div className={`simulation-timeline-icon ${meta.tone}`}><span className="material-symbols-outlined">{meta.icon}</span></div><div className="simulation-timeline-content"><div><span>{meta.label}</span><strong>{event.actor_name}</strong></div><p>{event.content}</p>{event.source_ids.length || event.argument_ids?.length ? <footer>{event.source_ids.map((sourceId) => <b key={sourceId}>{sourceId}</b>)}{event.argument_ids?.map((argumentId) => <i key={argumentId}>Argument</i>)}</footer> : null}</div></article>; })}</div></div> : null}

            {activeStep === 4 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 5</span><h1>Rapport et echanges</h1><p>Restitution exploitable pour une preparation, une formation ou une analyse strategique.</p></div><span className="material-symbols-outlined stage-icon">summarize</span></div>{caseData.report ? <div className="simulation-report"><section className="simulation-report-summary"><span className="material-symbols-outlined">auto_awesome</span><div><small>SYNTHESE</small><p>{caseData.report.summary}</p></div></section><div className="simulation-report-grid"><section><h3><span className="material-symbols-outlined">add_task</span> Points a soutenir</h3>{caseData.report.points_for.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">warning</span> Points de vigilance</h3>{caseData.report.points_against.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">shield</span> Risques</h3>{caseData.report.risks.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">alt_route</span> Issues possibles</h3>{caseData.report.outcomes.map((item) => <p key={item}>{item}</p>)}</section></div><aside className="simulation-disclaimer"><span className="material-symbols-outlined">info</span>{caseData.report.disclaimer}</aside><ArgumentEvidenceList arguments={caseData.arguments} sourceAnalysis={caseData.source_analysis} /></div> : <div className="simulation-panel-empty"><span className="material-symbols-outlined">summarize</span><p>Le rapport sera disponible a la fin de l'audience simulee.</p></div>}<section className="simulation-interaction"><div className="simulation-interaction-heading"><div><span className="simulation-eyebrow">Interroger un acteur</span><h2>Tester un argument ou une position</h2></div><select onChange={(event) => setSelectedActorId(event.target.value)} value={selectedActorId}>{caseData.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name} Â· {actor.role.replaceAll("_", " ")}</option>)}</select></div>{caseData.interactions.map((interaction) => <div className="simulation-chat-pair" key={interaction.id}><div className="user"><b>Vous</b><p>{interaction.question}</p></div><div className="actor"><b>{interaction.actor_name}</b><p>{interaction.answer}</p>{interaction.source_ids?.length ? <footer>{interaction.source_ids.map((sourceId) => <span key={sourceId}>{sourceId}</span>)}</footer> : null}</div></div>)}<div className="simulation-chat-input"><textarea disabled={!caseData.sources.length || interactionBusy} onChange={(event) => setInteractionQuestion(event.target.value)} placeholder={selectedActor ? `Questionner ${selectedActor.name}...` : "Choisissez un acteur..."} rows={2} value={interactionQuestion} /><button disabled={!caseData.sources.length || interactionBusy || interactionQuestion.trim().length < 2} onClick={() => void askActor()} type="button"><span className={`material-symbols-outlined ${interactionBusy ? "spin" : ""}`}>{interactionBusy ? "autorenew" : "north"}</span></button></div></section></div> : null}
              </div>

              {activeStep >= 2 ? (
                <aside className="simulation-live-graph" aria-label="Graphe juridique mis a jour en direct">
                  <SimulationRelationshipGraph graph={caseData.graph} isWorking={isWorking} variant="embedded" />
                </aside>
              ) : null}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
