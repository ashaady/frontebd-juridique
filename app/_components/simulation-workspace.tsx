"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildWorkspaceRequestHeaders } from "../_lib/workspace-api";
import { useTtsPlayer } from "../_hooks/use-tts-player";
import { SimulationDecisionTree, type SimulationDecisionItem } from "./simulation-decision-tree";
import { SimulationGraphComparison } from "./simulation-graph-comparison";
import { SimulationGraphGuide } from "./simulation-graph-guide";
import { useSimulationGraphStore } from "./simulation-graph-store";
import { SimulationRelationshipGraph } from "./simulation-relationship-graph";
import { SimulationSemanticProjection, type SemanticProjection } from "./simulation-semantic-projection";
import { Simulation3DGraph } from "./simulation-3d-graph";

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
  stage?: string;
  type: string;
  actor_id: string;
  actor_name: string;
  actor_role?: string;
  content: string;
  source_ids: string[];
  argument_ids?: string[];
  created_at?: string;
};

type SimulationTraceItem = {
  stage: string;
  status: string;
  completed_at?: string;
  argument_count?: number;
};

type SimulationCycle = {
  id: string;
  sequence: number;
  title: string;
  description: string;
  status: "pending" | "running" | "completed";
  started_at?: string | null;
  completed_at?: string | null;
  messages: SimulationEvent[];
};

type SimulationGraphNode = {
  id: string;
  label: string;
  type: "case" | "actor" | "issue" | "source" | "document" | "argument";
  detail?: string;
  cycle_created?: number;
  cycle_ended?: number | null;
  evidence_score?: number;
  evidence_band?: "non_soutenu" | "faible" | "moyenne" | "forte";
  evidence_metrics?: { legal_sources?: number; factual_exhibits?: number; issues?: number; refutations?: number };
  refutation_count?: number;
  contested_by_ids?: string[];
};

type SimulationGraph = {
  nodes: SimulationGraphNode[];
  edges: { source: string; target: string; label: string; cycle_created?: number }[];
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
  graph_initial?: SimulationGraph;
  decision_tree?: SimulationDecisionItem[];
  events: SimulationEvent[];
  cycles?: SimulationCycle[];
  report: SimulationReport | null;
  interactions: SimulationInteraction[];
  agent_memories: Record<string, { actor_id: string; actor_name: string; role: string; content: string; argument_ids: string[] }>;
  arguments: SimulationArgument[];
  source_analysis: SimulationSourceAnalysis;
  simulation_trace?: SimulationTraceItem[];
  retrieval: { query?: string; search_query?: string; rewrite_status?: string; source_count?: number };
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

function eventStage(event: SimulationEvent): string {
  if (event.stage) return event.stage;
  return event.type === "source_review" ? "analyse_sources"
    : event.type === "submission" ? "memorandum_initial"
    : event.type === "response" ? "memorandum_adverse"
    : event.type === "rebuttal" ? "replique"
    : event.type === "deliberation" ? "analyse_autorite"
    : event.type === "risk_assessment" ? "analyse_risques"
    : "";
}

function fallbackCycles(events: SimulationEvent[], trace: SimulationTraceItem[]): SimulationCycle[] {
  const definitions = [
    { id: "cycle-1", sequence: 1, title: "Examen du dossier", description: "Analyse des sources et presentation de la position initiale.", stages: ["analyse_sources", "memorandum_initial"] },
    { id: "cycle-2", sequence: 2, title: "Debat contradictoire", description: "Reponse de la partie adverse et replique sur les points contestes.", stages: ["memorandum_adverse", "replique"] },
    { id: "cycle-3", sequence: 3, title: "Evaluation et synthese", description: "Analyse neutre de l'autorite et examen des risques du dossier.", stages: ["analyse_autorite", "analyse_risques"] }
  ];
  const completedStages = new Set(trace.filter((item) => item.status === "completed").map((item) => item.stage));
  return definitions.map((definition) => {
    const messages = events.filter((event) => definition.stages.includes(eventStage(event)));
    const completed = definition.stages.every((stage) => completedStages.has(stage));
    return {
      id: definition.id,
      sequence: definition.sequence,
      title: definition.title,
      description: definition.description,
      status: completed ? "completed" : messages.length ? "running" : "pending",
      messages
    };
  });
}

function CycleConversation({
  cycle,
  actors,
  activeSpeechKey,
  loadingSpeechKey,
  simulationSpeechAvailable,
  onToggleSpeech,
}: {
  cycle: SimulationCycle;
  actors: SimulationActor[];
  activeSpeechKey: string | null;
  loadingSpeechKey: string | null;
  simulationSpeechAvailable: boolean;
  onToggleSpeech: (key: string, text: string, voiceSlot: number) => void;
}) {
  const statusLabel = cycle.status === "completed" ? "Cycle termine" : cycle.status === "running" ? "Cycle en cours" : "A venir";
  return (
    <section className={"simulation-conversation-cycle " + cycle.status}>
      <header className="simulation-conversation-cycle-header">
        <div className="simulation-cycle-number">{cycle.sequence}</div>
        <div>
          <small>Cycle {cycle.sequence}</small>
          <h2>{cycle.title}</h2>
          <p>{cycle.description}</p>
        </div>
        <span><i />{statusLabel}</span>
      </header>
      {cycle.messages.length ? (
        <div className="simulation-message-thread">
          {cycle.messages.map((message, index) => {
            const actor = actors.find((item) => item.id === message.actor_id);
            const role = message.actor_role || actor?.role || "";
            const meta = EVENT_META[message.type] || EVENT_META.argument;
            const isRight = index % 2 === 1;
            const speechKey = `simulation-event:${message.id}`;
            const actorIndex = Math.max(0, actors.findIndex((item) => item.id === message.actor_id));
            return (
              <article className={"simulation-cycle-message " + (isRight ? "right " : "left ") + meta.tone} key={message.id}>
                <div className="simulation-message-avatar" title={message.actor_name}>{message.actor_name.slice(0, 1).toUpperCase()}</div>
                <div className="simulation-message-bubble">
                  <header>
                    <div><strong>{message.actor_name}</strong><span>{role.replaceAll("_", " ") || meta.label}</span></div>
                    <time>{message.created_at ? formatDate(message.created_at) : "Intervention " + message.sequence}</time>
                  </header>
                  <p>{message.content}</p>
                  <footer>
                    {message.source_ids.map((sourceId) => <b key={sourceId}>{sourceId}</b>)}
                    {message.argument_ids?.map((argumentId) => <i key={argumentId}>Argument</i>)}
                    {simulationSpeechAvailable ? (
                      <button
                        aria-label={activeSpeechKey === speechKey ? "Arreter la lecture" : `Ecouter ${message.actor_name}`}
                        className="simulation-tts-button"
                        onClick={() => onToggleSpeech(speechKey, message.content, actorIndex + 1)}
                        type="button"
                      >
                        <span className={`material-symbols-outlined ${loadingSpeechKey === speechKey ? "spin" : ""}`}>
                          {loadingSpeechKey === speechKey ? "progress_activity" : activeSpeechKey === speechKey ? "stop_circle" : "volume_up"}
                        </span>
                        {activeSpeechKey === speechKey ? "Arreter" : "Ecouter"}
                      </button>
                    ) : null}
                  </footer>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="simulation-cycle-waiting"><span className="material-symbols-outlined">schedule</span>Ce cycle commencera apres le precedent.</div>
      )}
    </section>
  );
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
          <p>La couverture indique seulement si un argument est relie aux sources ou pieces du dossier. Elle ne prejuge pas de sa validite juridique.</p>
        </div>
        <span className="material-symbols-outlined">verified</span>
      </header>
      {sourceAssessments.length ? (
        <div className="simulation-source-assessments">
          {sourceAssessments.map((assessment) => <article key={`${assessment.source_id}-${assessment.summary}`}><b>{assessment.source_id}</b><div><strong>{[assessment.kind, assessment.stance].filter(Boolean).join(" Â· ").replaceAll("_", " ")}</strong><p>{assessment.summary}{assessment.ratio ? ` Portee: ${assessment.ratio}` : ""}</p></div></article>)}
        </div>
      ) : null}
      {visibleArguments.length ? (
        <div className="simulation-argument-list">
          {visibleArguments.map((argument) => <article className={argument.support_status} key={argument.id}>
            <div className="simulation-argument-heading"><strong>{argument.actor_name}</strong><span>{argument.support_status.replaceAll("_", " ")}</span></div>
            <p>{argument.claim}</p>
            {argument.explanation ? <small>{argument.explanation}</small> : null}
            <footer>{argument.source_ids.map((sourceId) => <b key={sourceId}>{sourceId}</b>)}{argument.attachment_ids.length ? <i>Piece privee</i> : null}{!argument.source_ids.length && !argument.attachment_ids.length ? <i>Sans reference declaree</i> : null}</footer>
          </article>)}
        </div>
      ) : null}
    </section>
  );
}

export function SimulationWorkspace({ forceNewSimulation = false }: { forceNewSimulation?: boolean }) {
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
  const focusedGraphNodeId = useSimulationGraphStore((state) => state.focusedNodeId);
  const graphFocalView = useSimulationGraphStore((state) => state.focalView);
  const resetGraphForCase = useSimulationGraphStore((state) => state.resetForCase);
  const setFocusedGraphNodeId = useSimulationGraphStore((state) => state.setFocusedNodeId);
  const setGraphFocalView = useSimulationGraphStore((state) => state.setFocalView);
  const [semanticProjection, setSemanticProjection] = useState<SemanticProjection | null>(null);
  const [projectionBusy, setProjectionBusy] = useState(false);
  const simulationSpeech = useTtsPlayer(setError);

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

  useEffect(() => {
    if (!forceNewSimulation) return;
    setCaseData(null);
    setIsCreatingNew(true);
    setActiveStep(0);
  }, [forceNewSimulation]);

  const loadSemanticProjection = useCallback(async () => {
    if (!caseData || projectionBusy) return;
    setProjectionBusy(true);
    setError("");
    try {
      const result = await request<SemanticProjection>(`/simulation/cases/${caseData.id}/projection?method=umap&max_points=64`);
      setSemanticProjection(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Projection semantique indisponible.");
    } finally {
      setProjectionBusy(false);
    }
  }, [caseData, projectionBusy, request]);

  useEffect(() => {
    setSemanticProjection(null);
    resetGraphForCase(caseData?.id || null);
  }, [caseData?.id, resetGraphForCase]);

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
      const storedId = forceNewSimulation ? null : window.localStorage.getItem(LAST_CASE_KEY);
      const preferred = response.items.find((item) => item.id === storedId) || response.items[0];
      if (!forceNewSimulation && preferred && !caseData && !isCreatingNew) {
        setCaseData(preferred);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de charger les simulations.");
    }
  }, [caseData, forceNewSimulation, isCreatingNew, isSignedIn, request]);

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
    const timer = window.setInterval(() => void refreshCase(caseData.id), 10000);
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
  const simulationCycles = useMemo(
    () => caseData
      ? (caseData.cycles?.length ? caseData.cycles : fallbackCycles(caseData.events, caseData.simulation_trace || []))
      : [],
    [caseData?.cycles, caseData?.events, caseData?.simulation_trace]
  );
  const visibleCycles = simulationCycles.filter((cycle) => cycle.status !== "pending" || cycle.messages.length > 0);
  const completedCycles = simulationCycles.filter((cycle) => cycle.status === "completed").length;

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
            <div className={`simulation-status ${caseData.status}`}><i /><div><strong>{caseData.status === "completed" ? "Simulation terminee" : caseData.status_message}</strong><small>{caseData.simulation_kind_label} - {caseData.jurisdiction}</small></div></div>
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
              <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 1</span><h1>Dossier probatoire</h1><p>La recherche est executee dans le corpus avant tout debat entre les acteurs.</p></div><span className="material-symbols-outlined stage-icon">folder_open</span></div><div className="simulation-facts-card"><span>FAITS DECLARES</span><p>{caseData.scenario}</p><div><i>Requete de recherche</i><code>{caseData.retrieval.search_query || caseData.retrieval.query || "Preparation en attente"}</code></div></div><section className="simulation-attachment-list"><div className="simulation-attachment-heading"><div><span className="simulation-eyebrow">Pieces jointes</span><h2>Elements factuels prives</h2></div><span>{caseData.attachments.length} PDF</span></div>{caseData.attachments.length ? caseData.attachments.map((attachment) => <article key={attachment.id}><span className="material-symbols-outlined">picture_as_pdf</span><div><strong>{attachment.name}</strong><small>{attachment.page_count} page{attachment.page_count > 1 ? "s" : ""} - {formatFileSize(attachment.size)} - Texte extrait</small></div><button onClick={() => void downloadPdf(attachment)} title={`Telecharger ${attachment.name}`} type="button"><span className="material-symbols-outlined">download</span></button></article>) : <p>Aucune piece jointe. Vous pouvez ajouter un PDF depuis les actions du dossier.</p>}</section><div className="simulation-source-list">{caseData.sources.length ? caseData.sources.map((source) => <article key={source.id}><div className="simulation-source-token">{source.id}</div><div><strong>{source.label}</strong><small>{source.citation}</small><p>{source.excerpt}</p></div><span className="material-symbols-outlined">menu_book</span></article>) : <div className="simulation-panel-empty"><span className="material-symbols-outlined">manage_search</span><p>{isWorking ? "Recherche documentaire en cours..." : "Aucune source disponible. Relancez la preparation du dossier."}</p></div>}</div></div>
            ) : null}

            {activeStep === 1 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 2</span><h1>Carte des relations</h1><p>Les liens montrent les acteurs, les questions juridiques et les passages qui structurent le scenario.</p></div><span className="material-symbols-outlined stage-icon">account_tree</span></div><div className="simulation-focal-toolbar" aria-label="Focales du graphe"><div><strong>Deux lectures du dossier</strong><span>La structure juridique et le debat restent synchronises par identifiant.</span></div><div className="simulation-focal-switch"><button className={graphFocalView === "split" ? "active" : ""} onClick={() => setGraphFocalView("split")} type="button"><span className="material-symbols-outlined">view_column</span>Ensemble</button><button className={graphFocalView === "debate" ? "active" : ""} onClick={() => setGraphFocalView("debate")} type="button"><span className="material-symbols-outlined">forum</span>Debat</button><button className={graphFocalView === "structure" ? "active" : ""} onClick={() => setGraphFocalView("structure")} type="button"><span className="material-symbols-outlined">account_tree</span>Structure</button><button className={graphFocalView === "3d" ? "active" : ""} onClick={() => setGraphFocalView("3d")} type="button"><span className="material-symbols-outlined">view_in_ar</span>3D</button></div></div><SimulationGraphGuide />{graphFocalView === "3d" ? <Simulation3DGraph focusedNodeId={focusedGraphNodeId} graph={caseData.graph} onNodeSelect={setFocusedGraphNodeId} /> : <div className={`simulation-double-focal ${graphFocalView === "split" ? "is-split" : ""}`}>{graphFocalView !== "structure" ? <SimulationRelationshipGraph focusedNodeId={focusedGraphNodeId} graph={caseData.graph} isWorking={isWorking} onNodeSelect={setFocusedGraphNodeId} scope="debate" variant="embedded" /> : null}{graphFocalView !== "debate" ? <SimulationRelationshipGraph focusedNodeId={focusedGraphNodeId} graph={caseData.graph} isWorking={isWorking} onNodeSelect={setFocusedGraphNodeId} scope="structure" variant="embedded" /> : null}</div>}<SimulationDecisionTree items={caseData.decision_tree || []} onFocusNode={(nodeId) => setFocusedGraphNodeId(nodeId)} /><SimulationGraphComparison finalGraph={caseData.graph} initialGraph={caseData.graph_initial} onFocusNode={setFocusedGraphNodeId} /><section className="simulation-projection-loader"><div><span className="simulation-eyebrow">G7 · Recherche semantique</span><h2>Explorer les proximites entre arguments</h2><p>Cette projection utilise les embeddings du meme modele que le RAG et ne modifie pas le retrieval standard.</p></div><button disabled={projectionBusy || !caseData.arguments.length} onClick={() => void loadSemanticProjection()} type="button"><span className={`material-symbols-outlined ${projectionBusy ? "spin" : ""}`}>{projectionBusy ? "autorenew" : "scatter_plot"}</span>{projectionBusy ? "Calcul en cours..." : semanticProjection ? "Recalculer la projection" : "Calculer la projection"}</button>{semanticProjection ? <SimulationSemanticProjection onFocusNode={setFocusedGraphNodeId} projection={semanticProjection} /> : null}</section></div> : null}

            {activeStep === 2 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 3</span><h1>Acteurs de la simulation</h1><p>Chaque role reste borne par les faits declares et les extraits du dossier.</p></div><span className="material-symbols-outlined stage-icon">groups</span></div><div className="simulation-actor-grid">{caseData.actors.map((actor) => <article key={actor.id}><div className="simulation-avatar">{actor.name.slice(0, 1).toUpperCase()}</div><div><span>{actor.kind === "institutional" ? "ROLE INSTITUTIONNEL" : "PARTIE"}</span><h3>{actor.name}</h3><b>{actor.role.replaceAll("_", " ")}</b><p>{actor.position || "Intervient dans le dossier selon son role procedurale."}</p></div></article>)}</div></div> : null}

            {activeStep === 3 ? (
              <div className="simulation-stage">
                <div className="simulation-stage-heading">
                  <div>
                    <span className="simulation-eyebrow">Etape 4</span>
                    <h1>Cycles de simulation</h1>
                    <p>Chaque cycle restitue plusieurs interventions contradictoires. Les cycles termines restent visibles pendant les suivants.</p>
                  </div>
                  <span className="material-symbols-outlined stage-icon">forum</span>
                </div>
                {caseData.status === "ready" ? (
                  <div className="simulation-run-ready">
                    <span className="material-symbols-outlined">record_voice_over</span>
                    <h2>Le dossier est pret a etre entendu.</h2>
                    <p>Les sources sont figees. Lancez les cycles pour faire intervenir successivement l'analyste, les parties et l'autorite simulatrice.</p>
                    <button className="simulation-primary-action" onClick={() => void runCase()} type="button">
                      <span className="material-symbols-outlined">play_arrow</span>
                      Lancer les cycles
                    </button>
                  </div>
                ) : null}
                {caseData.status === "running" ? (
                  <div className="simulation-running">
                    <span className="material-symbols-outlined spin">autorenew</span>
                    <strong>Discussion en cours...</strong>
                    <p>{completedCycles} cycle{completedCycles > 1 ? "s" : ""} termine{completedCycles > 1 ? "s" : ""}. Prochaine actualisation automatique dans 10 secondes.</p>
                  </div>
                ) : null}
                <div className="simulation-conversation-list" aria-live="polite">
                  {visibleCycles.map((cycle) => <CycleConversation
                    activeSpeechKey={simulationSpeech.activeKey}
                    actors={caseData.actors}
                    cycle={cycle}
                    key={cycle.id}
                    loadingSpeechKey={simulationSpeech.loadingKey}
                    simulationSpeechAvailable={simulationSpeech.available}
                    onToggleSpeech={(key, text, voiceSlot) => void simulationSpeech.toggle({ key, text, voiceSlot })}
                  />)}
                  {!visibleCycles.length && caseData.status !== "ready" ? (
                    <div className="simulation-panel-empty">
                      <span className="material-symbols-outlined">hourglass_empty</span>
                      <p>Le premier fil de discussion apparaitra des que l'analyse des sources sera terminee.</p>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeStep === 4 ? <div className="simulation-stage"><div className="simulation-stage-heading"><div><span className="simulation-eyebrow">Etape 5</span><h1>Rapport et echanges</h1><p>Restitution exploitable pour une preparation, une formation ou une analyse strategique.</p></div><span className="material-symbols-outlined stage-icon">summarize</span></div>{caseData.report ? <div className="simulation-report"><section className="simulation-report-summary"><span className="material-symbols-outlined">auto_awesome</span><div><small>SYNTHESE</small><p>{caseData.report.summary}</p></div></section><div className="simulation-report-grid"><section><h3><span className="material-symbols-outlined">add_task</span> Points a soutenir</h3>{caseData.report.points_for.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">warning</span> Points de vigilance</h3>{caseData.report.points_against.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">shield</span> Risques</h3>{caseData.report.risks.map((item) => <p key={item}>{item}</p>)}</section><section><h3><span className="material-symbols-outlined">alt_route</span> Issues possibles</h3>{caseData.report.outcomes.map((item) => <p key={item}>{item}</p>)}</section></div><aside className="simulation-disclaimer"><span className="material-symbols-outlined">info</span>{caseData.report.disclaimer}</aside><ArgumentEvidenceList arguments={caseData.arguments} sourceAnalysis={caseData.source_analysis} /></div> : <div className="simulation-panel-empty"><span className="material-symbols-outlined">summarize</span><p>Le rapport sera disponible a la fin de l'audience simulee.</p></div>}<section className="simulation-interaction"><div className="simulation-interaction-heading"><div><span className="simulation-eyebrow">Interroger un acteur</span><h2>Tester un argument ou une position</h2></div><select onChange={(event) => setSelectedActorId(event.target.value)} value={selectedActorId}>{caseData.actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name} - {actor.role.replaceAll("_", " ")}</option>)}</select></div>{caseData.interactions.map((interaction) => <div className="simulation-chat-pair" key={interaction.id}><div className="user"><b>Vous</b><p>{interaction.question}</p></div><div className="actor"><b>{interaction.actor_name}</b><p>{interaction.answer}</p>{interaction.source_ids?.length ? <footer>{interaction.source_ids.map((sourceId) => <span key={sourceId}>{sourceId}</span>)}</footer> : null}</div></div>)}<div className="simulation-chat-input"><textarea disabled={!caseData.sources.length || interactionBusy} onChange={(event) => setInteractionQuestion(event.target.value)} placeholder={selectedActor ? `Questionner ${selectedActor.name}...` : "Choisissez un acteur..."} rows={2} value={interactionQuestion} /><button disabled={!caseData.sources.length || interactionBusy || interactionQuestion.trim().length < 2} onClick={() => void askActor()} type="button"><span className={`material-symbols-outlined ${interactionBusy ? "spin" : ""}`}>{interactionBusy ? "autorenew" : "north"}</span></button></div></section></div> : null}
              </div>

              {activeStep >= 2 ? (
                <aside className="simulation-live-graph" aria-label="Graphe juridique mis a jour en direct">
                  <SimulationRelationshipGraph focusedNodeId={focusedGraphNodeId} graph={caseData.graph} isWorking={isWorking} variant="embedded" />
                </aside>
              ) : null}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
