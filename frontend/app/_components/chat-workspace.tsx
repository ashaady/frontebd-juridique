"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignInButton, SignedIn, SignedOut, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { jsPDF } from "jspdf";
import {
  buildLibraryViewUrl,
  clearConsultationsApi,
  clearWorkspaceFilesApi,
  listLibraryDocumentsApi,
  readConsultationsApi,
  readWorkspaceTemplatesApi,
  readWorkspaceFilesApi,
  readWorkspaceNotesApi,
  resolveLibraryChunksApi,
  setWorkspaceUserContext,
  transcribeSpeechApi,
  upsertConsultationApi,
  uploadWorkspaceFilesApi,
  writeWorkspaceFilesApi,
  writeWorkspaceNotesApi,
  type LibraryChunkRecord,
  type LibraryDocumentRecord,
} from "../_lib/workspace-api";
import {
  type ConsultationRecord,
  type CustomDocumentTemplateRecord,
  type WorkspaceFileRecord
} from "../_lib/workspace-store";
import { clerkUserButtonAppearance } from "../_lib/clerk-theme";

type RagSource = {
  rank?: number;
  score?: number;
  chunk_id?: string;
  citation?: string;
  relative_path?: string | null;
  source_path?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  article_hint?: string | null;
};

type TurnStatus = "done" | "streaming" | "error";

type Turn = {
  id: string;
  question: string;
  displayQuestion?: string;
  answer: string;
  reasoning: string;
  status: TurnStatus;
  ragSources: RagSource[];
  ragNote: string;
  finishReason: string;
};

type StreamMetaEvent = {
  rag_sources?: RagSource[];
  rag_note?: string;
};

type StreamTokenEvent = {
  text?: string;
};

type StreamReasoningEvent = {
  text?: string;
};

type StreamDoneEvent = {
  finish_reason?: string;
  rag_note?: string;
};

type StreamReplaceEvent = {
  text?: string;
};

type StreamErrorEvent = {
  detail?: string;
};

type ChatMessagePayload = {
  role: "user" | "assistant";
  content: string;
};

type CitationCard = {
  badge: string;
  excerpt: string;
  meta: string;
  chunkId?: string;
  articleHint?: string;
  sourcePath?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
};

type SourceBreakdownItem = {
  label: string;
  count: number;
  percent: number;
};

type ChatWorkspaceProps = {
  initialQuestion?: string;
  autoOpenActGenerator?: boolean;
  initialActTemplateId?: string;
};

type RightPanelTab = "workspace" | "notes" | "files";
type ActFieldType = "text" | "textarea" | "date" | "number" | "select";
type ActType = string;

type ActFieldDefinition = {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  type?: ActFieldType;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
};

type ActTemplateDefinition = {
  type: ActType;
  label: string;
  category: string;
  description: string;
  branch: string;
  fields: ActFieldDefinition[];
  isCustom?: boolean;
};

type SendQuestionOptions = {
  disableRagRewrite?: boolean;
  displayQuestion?: string;
  workspaceOnly?: boolean;
  workspaceFileIds?: string[];
};

type PdfBlockKind = "h1" | "h2" | "h3" | "p" | "li";
type PdfBlock = {
  kind: PdfBlockKind;
  text: string;
};

type ActWizardStep = 1 | 2 | 3;

type PopupChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ActValidationResult = {
  status: "missing" | "complete";
  missingItems: string[];
  assistantReply: string;
  documentText: string;
};

const QUICK_QUESTIONS: string[] = [
  "Quelles sont les clauses abusives courantes au Senegal ?",
  "Impact de la loi 2021 sur les contrats electroniques ?",
  "Delais de prescription pour une creance commerciale ?"
];
const WORKSPACE_ONLY_AUTO_PROMPT =
  "Analyse le document joint et fournis une synthese juridique exploitable (resume, risques, points sensibles, recommandations).";
const HISTORY_TITLE_MAX_CHARS = 96;

const ACT_TEMPLATES: Record<ActType, ActTemplateDefinition> = {
  contrat_bail: {
    type: "contrat_bail",
    label: "Contrat de bail",
    category: "Contrats civils",
    description: "Bail d'habitation ou commercial conforme au droit senegalais.",
    branch: "Droit des obligations / baux",
    fields: [
      { key: "bailleur_nom", label: "Nom du bailleur", required: true, placeholder: "Ex: M. Abdou Ndiaye" },
      { key: "locataire_nom", label: "Nom du locataire", required: true, placeholder: "Ex: Mme Awa Diop" },
      { key: "adresse_bien", label: "Adresse du bien", required: true, placeholder: "Ex: Cite Keur Gorgui, Dakar" },
      {
        key: "usage_bien",
        label: "Usage du bien",
        required: true,
        type: "select",
        options: [
          { value: "habitation", label: "Habitation" },
          { value: "commercial", label: "Commercial" }
        ]
      },
      { key: "duree_bail", label: "Duree du bail", required: true, placeholder: "Ex: 1 an renouvelable" },
      { key: "loyer_mensuel", label: "Loyer mensuel", required: true, placeholder: "Ex: 250000 FCFA", type: "number" },
      { key: "depot_garantie", label: "Depot de garantie", required: true, placeholder: "Ex: 2 mois de loyer" },
      { key: "date_effet", label: "Date d'effet", required: true, type: "date" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" },
      { key: "clauses_particulieres", label: "Clauses particulieres", type: "textarea", placeholder: "Conditions speciales, charges, entretien..." }
    ]
  },
  contrat_travail: {
    type: "contrat_travail",
    label: "Contrat de travail",
    category: "Contrats de travail",
    description: "Contrat adapte au Code du travail senegalais.",
    branch: "Droit du travail",
    fields: [
      { key: "employeur_nom", label: "Nom de l'employeur", required: true, placeholder: "Entreprise ou personne" },
      { key: "salarie_nom", label: "Nom du salarie", required: true, placeholder: "Nom complet" },
      { key: "poste", label: "Poste", required: true, placeholder: "Ex: Assistant comptable" },
      {
        key: "type_contrat",
        label: "Type de contrat",
        required: true,
        type: "select",
        options: [
          { value: "CDI", label: "CDI" },
          { value: "CDD", label: "CDD" },
          { value: "stage", label: "Stage" },
          { value: "temps_partiel", label: "Temps partiel" }
        ]
      },
      { key: "date_debut", label: "Date de debut", required: true, type: "date" },
      { key: "date_fin", label: "Date de fin (si applicable)", type: "date" },
      { key: "remuneration", label: "Remuneration", required: true, placeholder: "Ex: 300000 FCFA brut/mois" },
      { key: "lieu_travail", label: "Lieu de travail", required: true, placeholder: "Ex: Dakar Plateau" },
      { key: "convention_collective", label: "Convention collective", placeholder: "Ex: Commerce" },
      { key: "periode_essai", label: "Periode d'essai", placeholder: "Ex: 3 mois" },
      { key: "clauses_particulieres", label: "Clauses particulieres", type: "textarea", placeholder: "Non-concurrence, confidentialite..." }
    ]
  },
  mise_en_demeure: {
    type: "mise_en_demeure",
    label: "Mise en demeure",
    category: "Contentieux et precontentieux",
    description: "Lettre de sommation formelle avant action judiciaire.",
    branch: "Procedure civile / obligations",
    fields: [
      { key: "expediteur_nom", label: "Nom de l'expediteur", required: true, placeholder: "Nom complet" },
      { key: "destinataire_nom", label: "Nom du destinataire", required: true, placeholder: "Nom complet" },
      { key: "objet_litige", label: "Objet du litige", required: true, placeholder: "Ex: Loyers impayes" },
      { key: "faits", label: "Faits", required: true, type: "textarea", placeholder: "Expose chronologique des faits" },
      { key: "montant_reclame", label: "Montant reclame", placeholder: "Ex: 900000 FCFA", type: "number" },
      { key: "delai_accorde", label: "Delai accorde", required: true, placeholder: "Ex: 8 jours" },
      { key: "date_lettre", label: "Date de la lettre", required: true, type: "date" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" },
      { key: "pieces_justificatives", label: "Pieces justificatives", type: "textarea", placeholder: "Contrat, recus, courriers..." }
    ]
  },
  plainte_penale: {
    type: "plainte_penale",
    label: "Plainte penale",
    category: "Procedure penale",
    description: "Plainte fondee sur le Code penal et le Code de procedure penale senegalais.",
    branch: "Droit penal / procedure penale",
    fields: [
      { key: "plaignant_nom", label: "Nom du plaignant", required: true, placeholder: "Nom complet" },
      { key: "mis_en_cause", label: "Personne mise en cause", placeholder: "Nom si connu" },
      { key: "faits_detail", label: "Description des faits", required: true, type: "textarea", placeholder: "Date, lieu, circonstances" },
      { key: "date_faits", label: "Date des faits", required: true, type: "date" },
      { key: "lieu_faits", label: "Lieu des faits", required: true, placeholder: "Ex: Medina, Dakar" },
      { key: "infractions_suspectees", label: "Infractions suspectees", placeholder: "Ex: abus de confiance, escroquerie" },
      { key: "prejudice_subi", label: "Prejudice subi", required: true, placeholder: "Ex: 1500000 FCFA" },
      { key: "temoins_preuves", label: "Temoins / preuves", type: "textarea", placeholder: "Temoins, photos, messages, documents" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" }
    ]
  },
  requete: {
    type: "requete",
    label: "Requete",
    category: "Procedure civile",
    description: "Requete adressee a une juridiction ou une autorite competente.",
    branch: "Procedure",
    fields: [
      { key: "requerant_nom", label: "Nom du requerant", required: true, placeholder: "Nom complet" },
      { key: "juridiction_cible", label: "Juridiction cible", required: true, placeholder: "Ex: Tribunal de Grande Instance de Dakar" },
      { key: "objet_requete", label: "Objet de la requete", required: true, placeholder: "Ex: Delivrance d'ordonnance" },
      { key: "faits", label: "Faits", required: true, type: "textarea", placeholder: "Exposes precis et circonstancies" },
      { key: "demandes_precises", label: "Demandes precises", required: true, type: "textarea", placeholder: "Ce que vous demandez au juge" },
      { key: "base_legale", label: "Base legale (si connue)", placeholder: "Articles ou textes applicables" },
      { key: "pieces_jointes", label: "Pieces jointes", type: "textarea", placeholder: "Liste des pieces" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" }
    ]
  },
  assignation: {
    type: "assignation",
    label: "Assignation",
    category: "Procedure civile",
    description: "Assignation introductive d'instance en matiere civile ou commerciale.",
    branch: "Procedure civile / commerciale",
    fields: [
      { key: "demandeur_nom", label: "Nom du demandeur", required: true, placeholder: "Nom complet" },
      { key: "defendeur_nom", label: "Nom du defendeur", required: true, placeholder: "Nom complet" },
      { key: "juridiction_cible", label: "Juridiction competente", required: true, placeholder: "Ex: Tribunal de Commerce de Dakar" },
      { key: "objet_assignation", label: "Objet", required: true, placeholder: "Ex: Recouvrement de creance" },
      { key: "faits", label: "Faits", required: true, type: "textarea", placeholder: "Faits et manquements" },
      { key: "demandes", label: "Demandes", required: true, type: "textarea", placeholder: "Condamnations sollicitees" },
      { key: "base_legale", label: "Base legale (si connue)", placeholder: "Articles applicables" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" }
    ]
  },
  procuration: {
    type: "procuration",
    label: "Procuration",
    category: "Mandats et representations",
    description: "Mandat donne a une personne pour agir au nom d'une autre.",
    branch: "Droit civil / representation",
    fields: [
      { key: "mandant_nom", label: "Nom du mandant", required: true, placeholder: "Nom complet" },
      { key: "mandataire_nom", label: "Nom du mandataire", required: true, placeholder: "Nom complet" },
      { key: "pouvoirs_conferes", label: "Pouvoirs conferes", required: true, type: "textarea", placeholder: "Actes autorises" },
      { key: "date_debut", label: "Date de debut", required: true, type: "date" },
      { key: "date_fin", label: "Date de fin", type: "date" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" },
      { key: "identification_piece", label: "Piece d'identite", placeholder: "Ex: CNI n°..." }
    ]
  },
  statuts_societe_ohada: {
    type: "statuts_societe_ohada",
    label: "Statuts de societe (OHADA)",
    category: "Societes et OHADA",
    description: "Projet de statuts conforme au droit des societes OHADA.",
    branch: "Droit OHADA / societes",
    fields: [
      { key: "denomination_sociale", label: "Denomination sociale", required: true, placeholder: "Nom de la societe" },
      {
        key: "forme_sociale",
        label: "Forme sociale",
        required: true,
        type: "select",
        options: [
          { value: "SARL", label: "SARL" },
          { value: "SA", label: "SA" },
          { value: "SNC", label: "SNC" },
          { value: "SCS", label: "SCS" }
        ]
      },
      { key: "siege_social", label: "Siege social", required: true, placeholder: "Adresse complete" },
      { key: "objet_social", label: "Objet social", required: true, type: "textarea", placeholder: "Activites de la societe" },
      { key: "capital_social", label: "Capital social", required: true, placeholder: "Ex: 1000000 FCFA", type: "number" },
      { key: "associes", label: "Associes", required: true, type: "textarea", placeholder: "Noms et repartition des parts/actions" },
      { key: "duree_societe", label: "Duree de la societe", required: true, placeholder: "Ex: 99 ans" },
      { key: "gerance_direction", label: "Gerance / direction", required: true, placeholder: "Nom du gerant / DG" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" }
    ]
  },
  reconnaissance_dette: {
    type: "reconnaissance_dette",
    label: "Reconnaissance de dette",
    category: "Contrats civils",
    description: "Acte constatant une dette et ses modalites de remboursement.",
    branch: "Droit des obligations",
    fields: [
      { key: "creancier_nom", label: "Nom du creancier", required: true, placeholder: "Nom complet" },
      { key: "debiteur_nom", label: "Nom du debiteur", required: true, placeholder: "Nom complet" },
      { key: "montant_dette", label: "Montant de la dette", required: true, placeholder: "Ex: 500000 FCFA", type: "number" },
      { key: "cause_dette", label: "Cause de la dette", required: true, placeholder: "Ex: Pret personnel" },
      { key: "date_exigibilite", label: "Date d'exigibilite", required: true, type: "date" },
      { key: "modalites_paiement", label: "Modalites de paiement", required: true, placeholder: "Ex: 5 mensualites" },
      { key: "interets", label: "Interets (si applicables)", placeholder: "Ex: 5% annuel" },
      { key: "garanties", label: "Garanties (si prevues)", placeholder: "Ex: caution personnelle" },
      { key: "ville", label: "Ville", required: true, placeholder: "Ex: Dakar" }
    ]
  }
};

const DEFAULT_ACT_TYPE: ActType = "contrat_bail";

const EMPTY_TURNS: Turn[] = [];

function normalizeActFieldType(value: unknown): ActFieldType {
  const lowered = String(value ?? "").trim().toLowerCase();
  if (lowered === "textarea") {
    return "textarea";
  }
  if (lowered === "date") {
    return "date";
  }
  if (lowered === "number") {
    return "number";
  }
  if (lowered === "select") {
    return "select";
  }
  return "text";
}

function sanitizeActFieldKey(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || `champ_${Date.now()}`;
}

function buildActTemplateFromCustom(
  template: CustomDocumentTemplateRecord
): ActTemplateDefinition | null {
  const type = String(template.id ?? "").trim();
  const label = String(template.name ?? "").trim();
  if (!type || !label) {
    return null;
  }
  let fields: ActFieldDefinition[] = Array.isArray(template.fields)
    ? template.fields
        .map((field, index): ActFieldDefinition | null => {
          const fieldLabel = String(field.label ?? "").trim();
          if (!fieldLabel) {
            return null;
          }
          const fieldKey = String(field.key ?? "").trim() || sanitizeActFieldKey(`${fieldLabel}_${index + 1}`);
          const typeValue = normalizeActFieldType(field.type);
          const options = Array.isArray(field.options)
            ? field.options
                .map((option) => {
                  const value = String(option.value ?? "").trim();
                  const label = String(option.label ?? "").trim() || value;
                  if (!value) {
                    return null;
                  }
                  return { value, label };
                })
                .filter((option): option is { value: string; label: string } => Boolean(option))
            : [];
          const parsedField: ActFieldDefinition = {
            key: fieldKey,
            label: fieldLabel,
            required: Boolean(field.required),
            placeholder: String(field.placeholder ?? "").trim() || undefined,
            type: typeValue,
            options: typeValue === "select" && options.length > 0 ? options : undefined,
            hint: String(field.hint ?? "").trim() || undefined,
          };
          return parsedField;
        })
        .filter((field) => field !== null) as ActFieldDefinition[]
    : [];

  if (fields.length === 0) {
    fields = (template.requiredFields ?? [])
      .map((label, index): ActFieldDefinition | null => {
        const fieldLabel = String(label ?? "").trim();
        if (!fieldLabel) {
          return null;
        }
        const fallbackField: ActFieldDefinition = {
          key: sanitizeActFieldKey(`${fieldLabel}_${index + 1}`),
          label: fieldLabel,
          required: true,
          type: "text" as const,
        };
        return fallbackField;
      })
      .filter((field) => field !== null) as ActFieldDefinition[];
  }
  if (fields.length === 0) {
    return null;
  }

  return {
    type,
    label,
    category: String(template.category ?? "").trim() || "Modeles personnalises",
    description: String(template.description ?? "").trim() || "Modele personnalise genere par IA.",
    branch: String(template.branch ?? "").trim() || String(template.domain ?? "").trim() || "Document juridique",
    fields,
    isCustom: true,
  };
}

function buildInitialActFormValues(template: ActTemplateDefinition | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (!template) {
    return values;
  }
  for (const field of template.fields) {
    values[field.key] = "";
  }
  return values;
}

function buildActGenerationPrompt(
  template: ActTemplateDefinition,
  values: Record<string, string>,
  userIntent: string
): string {
  const lines: string[] = [];
  for (const field of template.fields) {
    const value = (values[field.key] ?? "").trim();
    if (!value) {
      continue;
    }
    lines.push(`- ${field.label}: ${value}`);
  }

  const freeIntent = userIntent.trim();
  const maybeIntentBlock =
    freeIntent.length > 0 ? `\nContexte complementaire utilisateur:\n${freeIntent}\n` : "\n";

  return [
    `Generer un modele d'acte juridique: ${template.label}.`,
    `Branche juridique prioritaire: ${template.branch}.`,
    maybeIntentBlock.trimEnd(),
    "Informations disponibles:",
    lines.length > 0 ? lines.join("\n") : "- Aucune information fournie.",
    "",
    "Consignes de redaction:",
    "1) Si des informations essentielles manquent, poser d'abord une liste courte de questions ciblees et ne pas rediger l'acte final.",
    "2) Si les informations sont suffisantes, rediger un document complet et structure avec:",
    "- Titre",
    "- Identification des parties",
    "- Visa juridique pertinent (Senegal / OHADA selon le cas)",
    "- Articles/clauses numerotes",
    "- Date et lieu",
    "- Signatures",
    "3) Adapter strictement au droit applicable (Code du travail senegalais, Code penal senegalais, OHADA, etc.).",
    "4) Repondre uniquement en francais.",
    "5) Terminer obligatoirement par cette mention:",
    "\"Ce document est un modele genere automatiquement et doit etre verifie par un professionnel du droit avant utilisation.\""
  ].join("\n");
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function extractJsonObjectFromText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return trimmed.slice(firstBrace, lastBrace + 1).trim();
}

function parseActValidationResponse(rawAnswer: string): ActValidationResult {
  const jsonCandidate = extractJsonObjectFromText(rawAnswer);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as {
        status?: string;
        missing_items?: unknown;
        assistant_reply?: unknown;
        document?: unknown;
      };
      const status = String(parsed.status || "").toLowerCase() === "missing" ? "missing" : "complete";
      const missingItems = Array.isArray(parsed.missing_items)
        ? parsed.missing_items
            .map((item) => String(item ?? "").trim())
            .filter((item) => item.length > 0)
        : [];
      const assistantReply = String(parsed.assistant_reply ?? "").trim();
      const documentText = String(parsed.document ?? "").trim();
      if (status === "missing" || missingItems.length > 0) {
        return {
          status: "missing",
          missingItems,
          assistantReply:
            assistantReply || "Il manque des informations pour rediger l'acte final.",
          documentText: "",
        };
      }
      return {
        status: "complete",
        missingItems: [],
        assistantReply: assistantReply || "Le projet d'acte est pret.",
        documentText: documentText || rawAnswer.trim(),
      };
    } catch {
      // fallback below
    }
  }
  return {
    status: "complete",
    missingItems: [],
    assistantReply: rawAnswer.trim(),
    documentText: rawAnswer.trim(),
  };
}

function buildActValidationPrompt(
  template: ActTemplateDefinition,
  values: Record<string, string>,
  userIntent: string,
  currentDocument: string = "",
  popupConversation: PopupChatMessage[] = [],
  userMessage: string = "Analyse les informations actuelles et produis la prochaine meilleure sortie."
): string {
  const filledLines = template.fields.map((field) => {
    const rawValue = (values[field.key] ?? "").trim();
    const value = rawValue.length > 0 ? rawValue : "[MANQUANT]";
    const requirementTag = field.required ? "OBLIGATOIRE" : "OPTIONNEL";
    return `- ${field.label} [${requirementTag}]: ${value}`;
  });

  const contextBlock =
    userIntent.trim().length > 0
      ? `Contexte utilisateur:\n${userIntent.trim()}\n`
      : "Contexte utilisateur:\nAucun contexte complementaire.\n";
  const conversationLines =
    popupConversation.length > 0
      ? popupConversation
          .slice(-12)
          .map((message) =>
            `${message.role === "user" ? "Utilisateur" : "Assistant"}: ${message.content}`
          )
          .join("\n")
      : "Aucun echange precedent dans le mini chat.";
  const currentDocumentBlock =
    currentDocument.trim().length > 0
      ? `Document actuel a reviser (version en cours):\n${currentDocument.trim()}\n`
      : "Document actuel a reviser (version en cours):\nAucun document genere pour le moment.\n";

  return [
    `Tu dois verifier et rediger un ${template.label} (${template.branch}).`,
    "Tu es dans un mini chat de generation d'acte. Reponds uniquement en francais.",
    contextBlock,
    currentDocumentBlock,
    "Informations collectees:",
    ...filledLines,
    "",
    "Historique mini chat:",
    conversationLines,
    "",
    `Dernier message utilisateur: ${userMessage}`,
    "",
    "Regles:",
    "1) Retourne uniquement un JSON valide et rien d'autre.",
    "2) Schema JSON obligatoire:",
    '{"status":"missing|complete","missing_items":["..."],"assistant_reply":"...","document":"..."}',
    "3) Seules les informations marquees OBLIGATOIRE peuvent bloquer la generation.",
    "4) Les champs OPTIONNEL ne doivent jamais etre demandes comme condition bloquante.",
    "5) Si des informations obligatoires manquent: status=missing, missing_items non vide, assistant_reply contient des questions precises, document vide.",
    "6) Si toutes les informations obligatoires sont presentes: status=complete, missing_items vide, assistant_reply court, document complet.",
    "7) Si un document actuel existe et que l'utilisateur demande une modification, appliquer la modification directement sur ce document.",
    "8) N'appliquer une modification que si elle reste conforme au droit senegalais/OHADA.",
    "9) Si la demande de modification est non conforme ou illicite, refuser explicitement dans assistant_reply, conserver un document conforme dans document (version precedente ou corrigee conforme).",
    "10) Le document final doit etre structure: titre, parties, base legale, clauses/articles, date/lieu, signatures.",
    "11) Adapter au droit applicable Senegal/OHADA selon la matiere.",
    "12) Ne produis jamais de code informatique.",
    "13) Terminer le document par cette mention exacte:",
    '"Ce document est un modele genere automatiquement et doit etre verifie par un professionnel du droit avant utilisation."',
    "14) Ne retourne aucun texte hors JSON."
  ].join("\n");
}

function _extractStringsDeep(value: unknown, depth: number = 0): string[] {
  if (depth > 6 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      out.push(..._extractStringsDeep(item, depth + 1));
    }
    return out;
  }
  if (typeof value !== "object") {
    return [];
  }

  const dict = value as Record<string, unknown>;
  const preferredKeys = [
    "answer",
    "output_text",
    "generated_text",
    "text",
    "content",
    "message",
    "output",
    "choices",
    "data",
    "result",
    "response",
  ];
  const forbiddenKeys = new Set([
    "rag_note",
    "rag_error",
    "status",
    "model",
    "finish_reason",
    "rag_enabled",
    "rag_source_count",
    "citation_underuse",
  ]);

  const out: string[] = [];
  for (const key of preferredKeys) {
    if (key in dict) {
      out.push(..._extractStringsDeep(dict[key], depth + 1));
    }
  }
  for (const [key, nested] of Object.entries(dict)) {
    if (preferredKeys.includes(key) || forbiddenKeys.has(key)) {
      continue;
    }
    out.push(..._extractStringsDeep(nested, depth + 1));
  }
  return out;
}

function extractAssistantTextFromChatPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const dict = payload as Record<string, unknown>;

  const directAnswer = dict.answer;
  if (typeof directAnswer === "string" && directAnswer.trim().length > 0) {
    return directAnswer.trim();
  }

  const choices = Array.isArray(dict.choices) ? dict.choices : [];
  if (choices.length > 0) {
    const firstChoice = choices[0] as Record<string, unknown>;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const delta = firstChoice?.delta as Record<string, unknown> | undefined;
    const candidateParts = [
      message?.content,
      delta?.content,
      firstChoice?.text,
    ];
    for (const part of candidateParts) {
      const strings = _extractStringsDeep(part);
      if (strings.length > 0) {
        return strings.join("\n").trim();
      }
    }
  }

  const output = dict.output;
  if (Array.isArray(output) && output.length > 0) {
    const outputStrings = _extractStringsDeep(output);
    if (outputStrings.length > 0) {
      return outputStrings.join("\n").trim();
    }
  }

  return "";
}

function parseConfidenceFromRagNote(ragNote: string): "high" | "medium" | "low" | "none" {
  const lowered = ragNote.toLowerCase();
  if (lowered.includes("confidence=high")) {
    return "high";
  }
  if (lowered.includes("confidence=medium")) {
    return "medium";
  }
  if (lowered.includes("confidence=low")) {
    return "low";
  }
  return "none";
}

function confidenceToPercent(level: "high" | "medium" | "low" | "none"): number {
  if (level === "high") {
    return 98;
  }
  if (level === "medium") {
    return 86;
  }
  if (level === "low") {
    return 72;
  }
  return 60;
}

function buildMessageHistory(turns: Turn[]): ChatMessagePayload[] {
  const history: ChatMessagePayload[] = [];
  for (const turn of turns) {
    if (turn.question.trim().length > 0) {
      history.push({ role: "user", content: turn.question });
    }
    if (turn.answer.trim().length > 0) {
      history.push({ role: "assistant", content: turn.answer });
    }
  }
  return history;
}

type PersistedSessionPayload = {
  version: 1;
  title: string;
  turns: Turn[];
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateHistoryTitle(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "Discussion";
  }
  if (normalized.length <= HISTORY_TITLE_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, HISTORY_TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

function extractFirstAttachmentName(displayQuestion: string): string {
  const lines = displayQuestion
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const attachmentLine = lines.find((line) => line.startsWith("📎"));
  if (!attachmentLine) {
    return "";
  }
  const normalized = attachmentLine.replace(/^📎\s*/, "").trim();
  if (!normalized) {
    return "";
  }
  const first = normalized.split(",")[0]?.split("+")[0]?.trim() ?? "";
  return first;
}

function deriveSessionTitle(turns: Turn[]): string {
  if (turns.length === 0) {
    return "Discussion";
  }
  const firstTurn = turns[0];
  const question = normalizeWhitespace(firstTurn.question ?? "");
  const displayQuestion = String(firstTurn.displayQuestion ?? "").trim();
  if (question && question.toLowerCase() !== WORKSPACE_ONLY_AUTO_PROMPT.toLowerCase()) {
    return truncateHistoryTitle(question);
  }
  if (question.toLowerCase() === WORKSPACE_ONLY_AUTO_PROMPT.toLowerCase()) {
    const attachmentName = extractFirstAttachmentName(displayQuestion);
    if (attachmentName) {
      return truncateHistoryTitle(attachmentName);
    }
    return "Document joint";
  }
  const displayFirstLine = displayQuestion.split("\n")[0]?.trim() ?? "";
  if (displayFirstLine) {
    return truncateHistoryTitle(displayFirstLine);
  }
  return "Discussion";
}

function normalizePersistedStatus(value: unknown): TurnStatus {
  if (value === "error") {
    return "error";
  }
  if (value === "streaming") {
    return "streaming";
  }
  return "done";
}

function normalizePersistedRagSources(value: unknown): RagSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: RagSource[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const source = row as Record<string, unknown>;
    normalized.push({
      rank: typeof source.rank === "number" ? source.rank : undefined,
      score: typeof source.score === "number" ? source.score : undefined,
      chunk_id: typeof source.chunk_id === "string" ? source.chunk_id : undefined,
      citation: typeof source.citation === "string" ? source.citation : undefined,
      relative_path: typeof source.relative_path === "string" ? source.relative_path : null,
      source_path: typeof source.source_path === "string" ? source.source_path : null,
      page_start: typeof source.page_start === "number" ? source.page_start : null,
      page_end: typeof source.page_end === "number" ? source.page_end : null,
      article_hint: typeof source.article_hint === "string" ? source.article_hint : null,
    });
  }
  return normalized;
}

function buildSessionPayload(title: string, turns: Turn[]): string {
  const payload: PersistedSessionPayload = {
    version: 1,
    title: truncateHistoryTitle(title),
    turns: turns.map((turn) => ({
      id: String(turn.id || ""),
      question: String(turn.question || ""),
      displayQuestion: turn.displayQuestion ? String(turn.displayQuestion) : undefined,
      answer: String(turn.answer || ""),
      reasoning: String(turn.reasoning || ""),
      status: normalizePersistedStatus(turn.status),
      ragSources: normalizePersistedRagSources(turn.ragSources),
      ragNote: String(turn.ragNote || ""),
      finishReason: String(turn.finishReason || ""),
    })),
  };
  return JSON.stringify(payload);
}

function parseSessionPayload(answer: string): PersistedSessionPayload | null {
  const trimmed = String(answer ?? "").trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.version !== 1 || !Array.isArray(parsed.turns)) {
      return null;
    }
    const rows: Turn[] = [];
    parsed.turns.forEach((row, index) => {
      if (!row || typeof row !== "object") {
        return;
      }
      const turn = row as Record<string, unknown>;
      const question = String(turn.question ?? "").trim();
      const answerText = String(turn.answer ?? "").trim();
      if (!question && !answerText) {
        return;
      }
      rows.push({
        id: String(turn.id ?? "").trim() || `turn-restored-${index + 1}`,
        question,
        displayQuestion: String(turn.displayQuestion ?? "").trim() || undefined,
        answer: String(turn.answer ?? ""),
        reasoning: String(turn.reasoning ?? ""),
        status: normalizePersistedStatus(turn.status),
        ragSources: normalizePersistedRagSources(turn.ragSources),
        ragNote: String(turn.ragNote ?? ""),
        finishReason: String(turn.finishReason ?? ""),
      });
    });
    if (rows.length === 0) {
      return null;
    }
    return {
      version: 1,
      title: truncateHistoryTitle(String(parsed.title ?? "").trim()),
      turns: rows,
    };
  } catch {
    return null;
  }
}

function consultationTitle(record: ConsultationRecord): string {
  const direct = String(record.question ?? "").trim();
  if (direct && !/^session du/i.test(direct)) {
    return truncateHistoryTitle(direct);
  }
  const parsed = parseSessionPayload(record.answer);
  if (parsed?.title) {
    return truncateHistoryTitle(parsed.title);
  }
  if (direct) {
    return truncateHistoryTitle(direct.replace(/^session du/i, "Discussion"));
  }
  return "Discussion";
}

function composerFileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function dedupeComposerFiles(files: File[]): File[] {
  const byKey = new Map<string, File>();
  for (const file of files) {
    byKey.set(composerFileKey(file), file);
  }
  return Array.from(byKey.values());
}

function summarizeAttachedFileNames(fileNames: string[]): string {
  const clean = fileNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (clean.length === 0) {
    return "";
  }
  const preview = clean.slice(0, 3).join(", ");
  if (clean.length <= 3) {
    return preview;
  }
  return `${preview} +${clean.length - 3}`;
}

function buildQuestionDisplayLabel(
  question: string,
  attachedFileNames: string[],
  workspaceOnly: boolean
): string {
  const attachmentPreview = summarizeAttachedFileNames(attachedFileNames);
  const base = workspaceOnly
    ? "Analyse du document joint"
    : (question.trim().length > 0 ? question.trim() : "Question");
  if (!attachmentPreview) {
    return base;
  }
  return `${base}\n📎 ${attachmentPreview}`;
}

function extractArticleBadge(source: RagSource, index: number): string {
  const hint = (source.article_hint ?? "").trim();
  if (hint.length > 0) {
    const match = hint.match(/Article\s+[A-Za-z0-9.\-]+/i);
    if (match) {
      return `${match[0]} - COCC`;
    }
  }
  if (typeof source.rank === "number") {
    return `Source ${source.rank}`;
  }
  return `Source ${index + 1}`;
}

function buildCitationCards(sources: RagSource[]): CitationCard[] {
  return sources.slice(0, 8).map((source, index) => {
    const badge = extractArticleBadge(source, index);
    const excerpt = (source.article_hint ?? source.citation ?? "Reference juridique").trim();
    const meta = (source.citation ?? source.relative_path ?? source.source_path ?? "Base documentaire").trim();
    return {
      badge,
      excerpt,
      meta,
      chunkId: source.chunk_id ?? undefined,
      articleHint: source.article_hint ?? undefined,
      sourcePath: source.relative_path ?? source.source_path ?? undefined,
      pageStart: source.page_start ?? null,
      pageEnd: source.page_end ?? null,
    };
  });
}

function extractCitedSourceRanks(answer: string): Set<number> {
  const cited = new Set<number>();
  if (!answer.trim()) {
    return cited;
  }
  const regex = /\[source\s+(\d+)\]/gi;
  let match: RegExpExecArray | null = regex.exec(answer);
  while (match) {
    const raw = match[1];
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      cited.add(parsed);
    }
    match = regex.exec(answer);
  }
  return cited;
}

function sourceUsageKey(source: RagSource, index: number): string {
  if (source.chunk_id && source.chunk_id.trim().length > 0) {
    return `chunk:${source.chunk_id.trim()}`;
  }
  const path = (source.relative_path ?? source.source_path ?? "").trim();
  const citation = (source.citation ?? "").trim();
  const pageStart = source.page_start ?? "na";
  const pageEnd = source.page_end ?? "na";
  const rank = typeof source.rank === "number" ? source.rank : index + 1;
  return `doc:${path}|citation:${citation}|pages:${pageStart}-${pageEnd}|rank:${rank}`;
}

function selectSourcesUsedForResponse(answer: string, sources: RagSource[]): RagSource[] {
  if (sources.length === 0) {
    return [];
  }
  const citedRanks = extractCitedSourceRanks(answer);
  if (citedRanks.size === 0) {
    return [];
  }
  const dedup = new Map<string, RagSource>();
  for (const [index, source] of sources.entries()) {
    const rank = typeof source.rank === "number" && source.rank > 0 ? source.rank : index + 1;
    if (!citedRanks.has(rank)) {
      continue;
    }
    dedup.set(sourceUsageKey(source, index), source);
  }
  return Array.from(dedup.values()).sort((a, b) => {
    const rankA = typeof a.rank === "number" && a.rank > 0 ? a.rank : Number.MAX_SAFE_INTEGER;
    const rankB = typeof b.rank === "number" && b.rank > 0 ? b.rank : Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });
}

function inferSourceFamily(source: RagSource): string {
  const raw = `${source.relative_path ?? ""} ${source.source_path ?? ""} ${source.citation ?? ""}`.toLowerCase();
  if (raw.includes("jurisprudence") || raw.includes("cour supreme") || raw.includes("bulletin")) {
    return "Jurisprudence";
  }
  if (raw.includes("doctrine") || raw.includes("revue") || raw.includes("commentaire")) {
    return "Doctrine";
  }
  if (
    raw.includes("code") ||
    raw.includes("loi") ||
    raw.includes("decret") ||
    raw.includes("constitution") ||
    raw.includes("ordonnance") ||
    raw.includes("arrete")
  ) {
    return "Code penal / Lois";
  }
  return "Autres sources";
}

function buildSourceBreakdown(sources: RagSource[]): SourceBreakdownItem[] {
  if (sources.length === 0) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const source of sources) {
    const family = inferSourceFamily(source);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const total = sources.length;
  return Array.from(counts.entries())
    .map(([label, count]) => ({
      label,
      count,
      percent: Math.round((count / total) * 100),
    }))
    .sort((a, b) => b.percent - a.percent || b.count - a.count);
}

function normalizeSourceValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const unified = trimmed
    .replaceAll("\\", "/")
    .replace(/%2F/gi, "/")
    .replaceAll('"', "")
    .replaceAll("'", "")
    .replaceAll("`", "")
    .toLowerCase();
  let cleaned = unified
    .replace(/^[a-z]:/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "");
  const marker = "droit donnees/";
  const markerIndex = cleaned.indexOf(marker);
  if (markerIndex >= 0) {
    cleaned = cleaned.slice(markerIndex + marker.length);
  }
  return cleaned.trim();
}

function scoreCitationDocumentMatch(candidate: string, document: LibraryDocumentRecord): number {
  if (!candidate) {
    return 0;
  }
  const relativePath = normalizeSourceValue(document.relativePath);
  const fileName = normalizeSourceValue(document.fileName);
  if (!relativePath && !fileName) {
    return 0;
  }
  if (relativePath && candidate === relativePath) {
    return 120;
  }
  if (relativePath && candidate.endsWith(`/${relativePath}`)) {
    return 110;
  }
  if (relativePath && candidate.includes(relativePath)) {
    return 95;
  }
  if (fileName && candidate === fileName) {
    return 80;
  }
  if (fileName && candidate.endsWith(`/${fileName}`)) {
    return 72;
  }
  if (fileName && candidate.includes(fileName)) {
    return 60;
  }
  return 0;
}

function resolveCitationDocument(
  card: CitationCard,
  documents: LibraryDocumentRecord[]
): LibraryDocumentRecord | null {
  if (documents.length === 0) {
    return null;
  }
  const candidates = [normalizeSourceValue(card.sourcePath ?? ""), normalizeSourceValue(card.meta)].filter(
    (value) => value.length > 0
  );
  if (candidates.length === 0) {
    return null;
  }

  let bestScore = 0;
  let bestDocument: LibraryDocumentRecord | null = null;
  for (const candidate of candidates) {
    for (const document of documents) {
      const score = scoreCitationDocumentMatch(candidate, document);
      if (score > bestScore) {
        bestScore = score;
        bestDocument = document;
      }
    }
  }
  return bestDocument;
}

function parsePageFromCitationText(value: string): number | null {
  const match = value.match(/\b(?:p\.|pp\.)\s*(\d{1,4})/i);
  if (!match?.[1]) {
    return null;
  }
  const page = Number.parseInt(match[1], 10);
  if (!Number.isFinite(page) || page <= 0) {
    return null;
  }
  return page;
}

function normalizeHighlightNeedle(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length < 6) {
    return "";
  }
  if (cleaned.toLowerCase() === "reference juridique") {
    return "";
  }
  return cleaned.slice(0, 180);
}

function renderHighlightedChunk(text: string, hint: string): ReactNode {
  const needle = normalizeHighlightNeedle(hint);
  if (!needle) {
    return text;
  }
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const index = lowerText.indexOf(lowerNeedle);
  if (index < 0) {
    return text;
  }
  const before = text.slice(0, index);
  const hit = text.slice(index, index + needle.length);
  const after = text.slice(index + needle.length);
  return (
    <>
      {before}
      <mark className="rounded bg-yellow-300/70 px-1 text-black">{hit}</mark>
      {after}
    </>
  );
}

function nowTimeLabel(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatDateLabel(dateIso: string): string {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toSafeFileName(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
  if (!base) {
    return "document_juridique";
  }
  return base.slice(0, 80);
}

function isActGenerationPrompt(question: string): boolean {
  const lowered = question.toLowerCase();
  return lowered.includes("generer un modele d'acte juridique");
}

function buildStructuredDocumentBlocks(answer: string): PdfBlock[] {
  const lines = answer
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const blocks: PdfBlock[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) {
      return;
    }
    for (const item of listBuffer) {
      blocks.push({ kind: "li", text: item });
    }
    listBuffer = [];
  };

  for (const line of lines) {
    const bulletMatch = line.match(/^(?:[-*•]\s+)(.+)$/);
    if (bulletMatch) {
      listBuffer.push(bulletMatch[1].trim());
      continue;
    }

    flushList();

    if (/^article\s+[a-z0-9.\-]+/i.test(line)) {
      blocks.push({ kind: "h3", text: line });
      continue;
    }
    if (line.endsWith(":") && line.length <= 90) {
      blocks.push({ kind: "h2", text: line });
      continue;
    }
    if (/^[A-Z0-9\s'’.,:-]{12,}$/.test(line) && line.length <= 120) {
      blocks.push({ kind: "h1", text: line });
      continue;
    }
    blocks.push({ kind: "p", text: line });
  }

  flushList();

  return blocks.length > 0 ? blocks : [{ kind: "p", text: "Aucun contenu." }];
}

function highlightArticleReference(text: string): ReactNode[] {
  const articleRegex =
    /(\bArticle\s+(?:[A-Za-z]\.?\s*)?\d+[A-Za-z0-9.\-]*(?:\s*(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies))?\b|\bArticle\b)/gi;
  const chunks = text.split(articleRegex);
  return chunks.map((chunk, index) => {
    if (articleRegex.test(chunk)) {
      articleRegex.lastIndex = 0;
      return (
        <span className="text-[#21DF6C] font-semibold" key={`article-ref-${index}`}>
          {chunk}
        </span>
      );
    }
    articleRegex.lastIndex = 0;
    return <span key={`chunk-${index}`}>{chunk}</span>;
  });
}

function renderAnswerContent(answer: string): ReactNode {
  const rows = answer
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.length > 0);

  const paragraphs: string[] = [];
  const bullets: string[] = [];

  for (const row of rows) {
    if (row.startsWith("- ")) {
      bullets.push(row.slice(2).trim());
      continue;
    }
    paragraphs.push(row);
  }

  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const isLastParagraph = index === paragraphs.length - 1;
        const withMargin = !isLastParagraph || bullets.length > 0;
        return (
          <p className={`leading-relaxed ${withMargin ? "mb-4" : ""}`} key={`${paragraph}-${index}`}>
            {highlightArticleReference(paragraph)}
          </p>
        );
      })}
      {bullets.length > 0 ? (
        <ul className="list-disc pl-5 mt-4 space-y-2 text-sm text-slate-600 dark:text-slate-300">
          {bullets.map((bullet, index) => (
            <li key={`${bullet}-${index}`}>{highlightArticleReference(bullet)}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function ChatWorkspace({
  initialQuestion = "",
  autoOpenActGenerator = false,
  initialActTemplateId = "",
}: ChatWorkspaceProps) {
  const router = useRouter();
  const { isLoaded: isAuthLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const [turns, setTurns] = useState<Turn[]>(EMPTY_TURNS);
  const [sessionHistory, setSessionHistory] = useState<ConsultationRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => `session-${Date.now()}`);
  const [activeSessionCreatedAt, setActiveSessionCreatedAt] = useState<string>(() => new Date().toISOString());
  const [input, setInput] = useState<string>("");
  const [pendingComposerFiles, setPendingComposerFiles] = useState<File[]>([]);
  const [pendingComposerFileIdsByKey, setPendingComposerFileIdsByKey] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string>("");
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileRecord[]>([]);
  const [workspaceSelectedTurnId, setWorkspaceSelectedTurnId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("workspace");
  const [chunkDetailsById, setChunkDetailsById] = useState<Record<string, LibraryChunkRecord>>({});
  const [expandedChunkIds, setExpandedChunkIds] = useState<Record<string, boolean>>({});
  const [isMobileLeftPanelOpen, setIsMobileLeftPanelOpen] = useState<boolean>(false);
  const [isMobileRightPanelOpen, setIsMobileRightPanelOpen] = useState<boolean>(false);
  const [isWorkspacePanelOpen, setIsWorkspacePanelOpen] = useState<boolean>(false);
  const [hasAutoOpenedWorkspacePanel, setHasAutoOpenedWorkspacePanel] = useState<boolean>(false);
  const [hasDismissedWorkspacePanel, setHasDismissedWorkspacePanel] = useState<boolean>(false);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isUploadingComposerFiles, setIsUploadingComposerFiles] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);
  const [landingQuery, setLandingQuery] = useState<string>("");
  const [isActGeneratorOpen, setIsActGeneratorOpen] = useState<boolean>(false);
  const [actType, setActType] = useState<ActType>(DEFAULT_ACT_TYPE);
  const [actValues, setActValues] = useState<Record<string, string>>(
    () => buildInitialActFormValues(ACT_TEMPLATES[DEFAULT_ACT_TYPE] ?? null)
  );
  const [actUserIntent, setActUserIntent] = useState<string>("");
  const [actStep, setActStep] = useState<ActWizardStep>(1);
  const [actFieldError, setActFieldError] = useState<string>("");
  const [actMissingItems, setActMissingItems] = useState<string[]>([]);
  const [actGeneratedDocument, setActGeneratedDocument] = useState<string>("");
  const [actValidationError, setActValidationError] = useState<string>("");
  const [isActValidating, setIsActValidating] = useState<boolean>(false);
  const [actGenerationProgressPercent, setActGenerationProgressPercent] = useState<number>(0);
  const [popupChatMessages, setPopupChatMessages] = useState<PopupChatMessage[]>([]);
  const [popupChatInput, setPopupChatInput] = useState<string>("");
  const [isPopupChatSending, setIsPopupChatSending] = useState<boolean>(false);
  const [customActTemplates, setCustomActTemplates] = useState<ActTemplateDefinition[]>([]);
  const [globalError, setGlobalError] = useState<string>("");
  const [uiMessage, setUiMessage] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<BlobPart[]>([]);
  const isUploadingComposerFilesRef = useRef<boolean>(false);
  const turnsRef = useRef<Turn[]>(EMPTY_TURNS);
  const persistedSessionFingerprintRef = useRef<Map<string, string>>(new Map());
  const autoActOpenedRef = useRef(false);
  const autoSubmittedRef = useRef<string>("");
  const landingFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceFileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryDocumentsCacheRef = useRef<LibraryDocumentRecord[]>([]);
  const signInModalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const actGenerationProgressResetTimerRef = useRef<number | null>(null);

  const backendBaseUrl = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";
    return raw.replace(/\/+$/, "");
  }, []);
  const builtinActTemplates = useMemo(() => Object.values(ACT_TEMPLATES), []);
  const allActTemplates = useMemo(() => {
    const byType = new Map<string, ActTemplateDefinition>();
    for (const template of [...builtinActTemplates, ...customActTemplates]) {
      byType.set(template.type, template);
    }
    return Array.from(byType.values());
  }, [builtinActTemplates, customActTemplates]);
  const actTemplateMap = useMemo(
    () => new Map(allActTemplates.map((template) => [template.type, template])),
    [allActTemplates]
  );
  const expertiseDomains = useMemo(
    () => [
      {
        icon: "family_restroom",
        title: "Droit de la Famille",
        shortTitle: "Famille",
        desc: "Mariage, divorce, autorite parentale et successions au Senegal.",
        tone: "blue",
        href: "/bibliotheque?q=code%20de%20la%20famille",
      },
      {
        icon: "work",
        title: "Droit du Travail",
        shortTitle: "Travail",
        desc: "Contrats, licenciements, preavis et droits des salaries.",
        tone: "orange",
        href: "/bibliotheque?q=code%20du%20travail",
      },
      {
        icon: "home_work",
        title: "Immobilier",
        shortTitle: "Immobilier",
        desc: "Baux d'habitation, foncier et contentieux locatifs.",
        tone: "teal",
        href: "/bibliotheque?q=code%20urbanisme%20construction%20bail%20foncier",
      },
      {
        icon: "corporate_fare",
        title: "Droit des Affaires",
        shortTitle: "Affaires",
        desc: "OHADA, creation d'entreprise et fiscalite des societes.",
        tone: "primary",
        href: "/bibliotheque?q=ohada%20societes%20commerciales%20droit%20des%20affaires",
      },
    ] as const,
    []
  );
  const actTemplatesByCategory = useMemo(() => {
    const groups = new Map<string, ActTemplateDefinition[]>();
    for (const template of allActTemplates) {
      const key = template.category || "Autres";
      const rows = groups.get(key) ?? [];
      rows.push(template);
      groups.set(key, rows);
    }
    return Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right, "fr"))
      .map(([category, templates]) => ({
        category,
        templates: templates.sort((left, right) => left.label.localeCompare(right.label, "fr")),
      }));
  }, [allActTemplates]);

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }
    setWorkspaceUserContext(
      isSignedIn
        ? {
            userId: userId ?? null,
            email: user?.primaryEmailAddress?.emailAddress ?? null,
            displayName: user?.fullName ?? user?.firstName ?? null,
            username: user?.username ?? null,
          }
        : null
    );
  }, [isAuthLoaded, isSignedIn, userId, user]);

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }
    let active = true;
    const loadTemplates = async () => {
      const rows = await readWorkspaceTemplatesApi();
      const parsed = rows
        .map((template) => buildActTemplateFromCustom(template))
        .filter((template): template is ActTemplateDefinition => Boolean(template));
      if (active) {
        setCustomActTemplates(parsed);
      }
    };
    void loadTemplates();
    return () => {
      active = false;
    };
  }, [isAuthLoaded, isSignedIn, userId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const refreshCustomActTemplates = async () => {
      const rows = await readWorkspaceTemplatesApi();
      const parsed = rows
        .map((template) => buildActTemplateFromCustom(template))
        .filter((template): template is ActTemplateDefinition => Boolean(template));
      setCustomActTemplates(parsed);
    };
    const onFocus = () => {
      void refreshCustomActTemplates();
    };
    const onStorage = () => {
      void refreshCustomActTemplates();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const requireSignedIn = useCallback(
    (errorMessage?: string) => {
      if (!isAuthLoaded) {
        return false;
      }
      if (isSignedIn) {
        return true;
      }
      setGlobalError(errorMessage ?? "Connexion requise pour utiliser cette fonctionnalite.");
      signInModalTriggerRef.current?.click();
      return false;
    },
    [isAuthLoaded, isSignedIn]
  );

  const workspaceQuestionTurns = useMemo(
    () => turns.filter((turn) => turn.question.trim().length > 0),
    [turns]
  );
  const workspaceActiveTurn = useMemo(() => {
    if (workspaceSelectedTurnId) {
      const matched = workspaceQuestionTurns.find((turn) => turn.id === workspaceSelectedTurnId);
      if (matched) {
        return matched;
      }
    }
    return workspaceQuestionTurns.length > 0
      ? workspaceQuestionTurns[workspaceQuestionTurns.length - 1]
      : null;
  }, [workspaceQuestionTurns, workspaceSelectedTurnId]);
  const hasConversationStarted = turns.length > 0;
  const hasGeneratedResponse = useMemo(
    () => turns.some((turn) => turn.answer.trim().length > 0 || turn.status === "done" || turn.status === "error"),
    [turns]
  );
  const activeActTemplate =
    actTemplateMap.get(actType) ??
    actTemplateMap.get(DEFAULT_ACT_TYPE) ??
    allActTemplates[0] ??
    {
      type: DEFAULT_ACT_TYPE,
      label: "Acte juridique",
      category: "General",
      description: "Modele d'acte juridique",
      branch: "Droit",
      fields: [],
    };
  const resolveActTemplate = useCallback(
    (preferredType?: string): ActTemplateDefinition => {
      const normalizedPreferred = String(preferredType ?? "").trim();
      if (normalizedPreferred && actTemplateMap.has(normalizedPreferred)) {
        return actTemplateMap.get(normalizedPreferred)!;
      }
      if (actTemplateMap.has(DEFAULT_ACT_TYPE)) {
        return actTemplateMap.get(DEFAULT_ACT_TYPE)!;
      }
      return (
        allActTemplates[0] ?? {
          type: DEFAULT_ACT_TYPE,
          label: "Acte juridique",
          category: "General",
          description: "Modele d'acte juridique",
          branch: "Droit",
          fields: [],
        }
      );
    },
    [actTemplateMap, allActTemplates]
  );

  useEffect(() => {
    if (actTemplateMap.has(actType)) {
      return;
    }
    const nextTemplate = resolveActTemplate(initialActTemplateId);
    setActType(nextTemplate.type);
    setActValues(buildInitialActFormValues(nextTemplate));
  }, [actTemplateMap, actType, initialActTemplateId, resolveActTemplate]);
  const requiredActFields = useMemo(
    () => activeActTemplate.fields.filter((field) => Boolean(field.required)),
    [activeActTemplate.fields]
  );
  const completedRequiredActFields = useMemo(
    () =>
      requiredActFields.filter(
        (field) => (actValues[field.key] ?? "").trim().length > 0
      ).length,
    [actValues, requiredActFields]
  );
  const actProgressPercent = useMemo(() => {
    const total = requiredActFields.length || 1;
    return Math.round((completedRequiredActFields / total) * 100);
  }, [completedRequiredActFields, requiredActFields.length]);
  const actWizardProgressPercent = useMemo(() => {
    if (actStep === 1) {
      return 18;
    }
    if (actStep === 2) {
      return Math.round(33 + actProgressPercent * 0.34);
    }
    return 100;
  }, [actProgressPercent, actStep]);
  const actMenuProgressPercent = useMemo(() => {
    if (isActValidating || actGenerationProgressPercent > 0) {
      return Math.max(2, Math.min(100, Math.round(actGenerationProgressPercent)));
    }
    return Math.max(2, Math.min(100, Math.round(actWizardProgressPercent)));
  }, [actGenerationProgressPercent, actWizardProgressPercent, isActValidating]);

  useEffect(() => {
    if (!isActValidating) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setActGenerationProgressPercent((previous) => {
        if (previous >= 94) {
          return previous;
        }
        if (previous < 30) {
          return previous + 6;
        }
        if (previous < 70) {
          return previous + 3;
        }
        return previous + 1;
      });
    }, 280);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isActValidating]);

  useEffect(() => {
    return () => {
      if (actGenerationProgressResetTimerRef.current !== null) {
        window.clearTimeout(actGenerationProgressResetTimerRef.current);
      }
    };
  }, []);
  const missingFieldLabelSet = useMemo(
    () => new Set(actMissingItems.map((item) => normalizeForMatch(item))),
    [actMissingItems]
  );
  const sourcesUsedInAnswer = useMemo(
    () =>
      selectSourcesUsedForResponse(
        workspaceActiveTurn?.answer ?? "",
        workspaceActiveTurn?.ragSources ?? []
      ),
    [workspaceActiveTurn?.answer, workspaceActiveTurn?.ragSources]
  );
  const citationCards = useMemo(() => buildCitationCards(sourcesUsedInAnswer), [sourcesUsedInAnswer]);
  const sourceBreakdown = useMemo(
    () => buildSourceBreakdown(sourcesUsedInAnswer),
    [sourcesUsedInAnswer]
  );
  const confidenceLevel = parseConfidenceFromRagNote(workspaceActiveTurn?.ragNote ?? "");
  const confidencePercent = confidenceToPercent(confidenceLevel);
  const displayedSourceCount = sourcesUsedInAnswer.length;
  const filesFromSources = useMemo(() => {
    const rows = citationCards
      .map((card, index) => {
        const base = card.sourcePath ?? card.meta;
        return {
          id: `source-${index}-${base}`,
          name: base,
          size: 0,
          addedAt: new Date().toISOString()
        };
      })
      .filter((row) => row.name.trim().length > 0);
    return rows;
  }, [citationCards]);
  const allWorkspaceFiles = useMemo(() => {
    const map = new Map<string, WorkspaceFileRecord>();
    for (const file of workspaceFiles) {
      map.set(file.id, file);
    }
    for (const file of filesFromSources) {
      if (!map.has(file.id)) {
        map.set(file.id, file);
      }
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
    );
  }, [filesFromSources, workspaceFiles]);

  const appendToTurnAnswer = (turnId: string, text: string) => {
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === turnId ? { ...turn, answer: `${turn.answer}${text}` } : turn
      )
    );
  };

  const appendToTurnReasoning = (turnId: string, text: string) => {
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === turnId ? { ...turn, reasoning: `${turn.reasoning}${text}` } : turn
      )
    );
  };

  const patchTurn = (turnId: string, patch: Partial<Turn>) => {
    setTurns((previous) =>
      previous.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn))
    );
  };

  const replaceTurnAnswer = (turnId: string, text: string) => {
    setTurns((previous) =>
      previous.map((turn) =>
        turn.id === turnId ? { ...turn, answer: text } : turn
      )
    );
  };

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    if (workspaceQuestionTurns.length === 0) {
      if (workspaceSelectedTurnId !== null) {
        setWorkspaceSelectedTurnId(null);
      }
      return;
    }
    const selectionStillExists =
      workspaceSelectedTurnId !== null &&
      workspaceQuestionTurns.some((turn) => turn.id === workspaceSelectedTurnId);
    if (selectionStillExists) {
      return;
    }
    setWorkspaceSelectedTurnId(workspaceQuestionTurns[workspaceQuestionTurns.length - 1].id);
  }, [workspaceQuestionTurns, workspaceSelectedTurnId]);

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }
    if (!isSignedIn) {
      setNotes("");
      setWorkspaceFiles([]);
      setSessionHistory([]);
      return;
    }
    let active = true;
    const loadWorkspace = async () => {
      const [remoteNotes, remoteFiles, remoteConsultations] = await Promise.all([
        readWorkspaceNotesApi(),
        readWorkspaceFilesApi(),
        readConsultationsApi(),
      ]);
      if (!active) {
        return;
      }
      setNotes(remoteNotes);
      setWorkspaceFiles(remoteFiles);
      setSessionHistory(remoteConsultations);
    };
    void loadWorkspace();
    return () => {
      active = false;
    };
  }, [isAuthLoaded, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void writeWorkspaceNotesApi(notes);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [isSignedIn, notes]);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void writeWorkspaceFilesApi(workspaceFiles);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [isSignedIn, workspaceFiles]);

  useEffect(() => {
    const chunkIds = (workspaceActiveTurn?.ragSources ?? [])
      .map((source) => (typeof source.chunk_id === "string" ? source.chunk_id.trim() : ""))
      .filter((chunkId) => chunkId.length > 0);
    if (chunkIds.length === 0) {
      return;
    }
    const missingChunkIds = chunkIds.filter((chunkId) => !chunkDetailsById[chunkId]);
    if (missingChunkIds.length === 0) {
      return;
    }

    let active = true;
    const loadChunks = async () => {
      const rows = await resolveLibraryChunksApi(missingChunkIds);
      if (!active || rows.length === 0) {
        return;
      }
      setChunkDetailsById((previous) => {
        const next = { ...previous };
        for (const row of rows) {
          if (!row?.chunk_id) {
            continue;
          }
          next[row.chunk_id] = row;
        }
        return next;
      });
    };
    void loadChunks();
    return () => {
      active = false;
    };
  }, [workspaceActiveTurn?.id, workspaceActiveTurn?.ragSources, chunkDetailsById]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 1024) {
        setIsMobileLeftPanelOpen(false);
        setIsMobileRightPanelOpen(false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }
    const finalizedTurns = turns.filter((turn) => {
      if (turn.status !== "done" && turn.status !== "error") {
        return false;
      }
      if (!turn.question.trim() || !turn.answer.trim()) {
        return false;
      }
      return true;
    });
    if (finalizedTurns.length === 0) {
      return;
    }

    const latestTurn = finalizedTurns[finalizedTurns.length - 1];
    const sessionTitle = deriveSessionTitle(finalizedTurns);
    const sessionPayload = buildSessionPayload(sessionTitle, finalizedTurns);
    const sourceCount = finalizedTurns.reduce((sum, turn) => sum + turn.ragSources.length, 0);
    const status = latestTurn.status === "error" ? "error" : "done";
    const fingerprint = [
      sessionTitle,
      sessionPayload,
      status,
      latestTurn.finishReason,
      latestTurn.ragNote,
      String(sourceCount),
      String(finalizedTurns.length),
    ].join("|");
    const previousFingerprint = persistedSessionFingerprintRef.current.get(activeSessionId);
    if (previousFingerprint === fingerprint) {
      return;
    }
    persistedSessionFingerprintRef.current.set(activeSessionId, fingerprint);
    void upsertConsultationApi({
      id: activeSessionId,
      question: sessionTitle,
      answer: sessionPayload,
      status,
      finishReason: latestTurn.finishReason,
      ragNote: latestTurn.ragNote,
      sourceCount,
      createdAt: activeSessionCreatedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).then((rows) => {
      setSessionHistory(rows);
    }).catch(() => {
      // Ignore sidebar sync failures to avoid blocking chat.
    });
  }, [activeSessionCreatedAt, activeSessionId, isSignedIn, turns]);

  const sendQuestion = useCallback(async (question: string, options?: SendQuestionOptions) => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSending) {
      return;
    }
    const displayQuestion = (options?.displayQuestion ?? trimmedQuestion).trim() || trimmedQuestion;

    setGlobalError("");
    const turnId = `turn-${Date.now()}`;
    const turnSeed: Turn = {
      id: turnId,
      question: trimmedQuestion,
      displayQuestion,
      answer: "",
      reasoning: "",
      status: "streaming",
      ragSources: [],
      ragNote: "",
      finishReason: ""
    };

    const historyBeforeQuestion = buildMessageHistory(turnsRef.current);
    setTurns((previous) => [...previous, turnSeed]);
    setInput("");
    setIsSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${backendBaseUrl}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [...historyBeforeQuestion, { role: "user", content: trimmedQuestion }],
          temperature: 0.0,
          top_p: 0.9,
          thinking: false,
          rag_query_rewrite: options?.disableRagRewrite === true ? false : undefined,
          workspace_only: options?.workspaceOnly === true ? true : undefined,
          workspace_file_ids:
            Array.isArray(options?.workspaceFileIds) && options?.workspaceFileIds.length > 0
              ? options?.workspaceFileIds
              : undefined
        }),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        const detail = `Erreur HTTP ${response.status}`;
        patchTurn(turnId, {
          answer: detail,
          status: "error",
          finishReason: "http_error"
        });
        setGlobalError(detail);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamDone = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) {
            break;
          }

          const packet = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          if (!packet) {
            continue;
          }

          let eventName = "message";
          const dataLines: string[] = [];

          for (const line of packet.split("\n")) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (dataLines.length === 0) {
            continue;
          }

          let payload: unknown;
          try {
            payload = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }

          if (eventName === "meta") {
            const metaPayload = payload as StreamMetaEvent;
            patchTurn(turnId, {
              ragSources: Array.isArray(metaPayload.rag_sources) ? metaPayload.rag_sources : [],
              ragNote: typeof metaPayload.rag_note === "string" ? metaPayload.rag_note : ""
            });
            continue;
          }

          if (eventName === "token") {
            const tokenPayload = payload as StreamTokenEvent;
            if (typeof tokenPayload.text === "string" && tokenPayload.text.length > 0) {
              appendToTurnAnswer(turnId, tokenPayload.text);
            }
            continue;
          }

          if (eventName === "reasoning") {
            const reasoningPayload = payload as StreamReasoningEvent;
            if (typeof reasoningPayload.text === "string" && reasoningPayload.text.length > 0) {
              appendToTurnReasoning(turnId, reasoningPayload.text);
            }
            continue;
          }

          if (eventName === "done") {
            const donePayload = payload as StreamDoneEvent;
            patchTurn(turnId, {
              status: "done",
              finishReason:
                typeof donePayload.finish_reason === "string" ? donePayload.finish_reason : "stop",
              ragNote: typeof donePayload.rag_note === "string" ? donePayload.rag_note : ""
            });
            streamDone = true;
            break;
          }

          if (eventName === "replace") {
            const replacePayload = payload as StreamReplaceEvent;
            if (typeof replacePayload.text === "string") {
              replaceTurnAnswer(turnId, replacePayload.text);
            }
            continue;
          }

          if (eventName === "error") {
            const errorPayload = payload as StreamErrorEvent;
            const detail =
              typeof errorPayload.detail === "string"
                ? errorPayload.detail
                : "Une erreur est survenue pendant le streaming.";
            patchTurn(turnId, {
              status: "error",
              answer: detail,
              finishReason: "stream_error"
            });
            setGlobalError(detail);
            streamDone = true;
            break;
          }
        }

        if (streamDone) {
          break;
        }
      }

      if (!streamDone) {
        patchTurn(turnId, {
          status: "done",
          finishReason: "stop"
        });
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Impossible de contacter le backend.";
      patchTurn(turnId, {
        status: "error",
        answer: detail,
        finishReason: "network_error"
      });
      setGlobalError(detail);
    } finally {
      abortRef.current = null;
      setIsSending(false);
    }
  }, [backendBaseUrl, isSending]);

  const pendingDashboardQuestion = initialQuestion.trim();

  const clearQuestionParamFromUrl = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    if (!url.searchParams.has("q")) {
      return;
    }
    url.searchParams.delete("q");
    const cleanedUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", cleanedUrl || "/chat");
  }, []);

  useEffect(() => {
    if (!pendingDashboardQuestion) {
      return;
    }
    if (autoSubmittedRef.current === pendingDashboardQuestion) {
      return;
    }
    autoSubmittedRef.current = pendingDashboardQuestion;
    setInput(pendingDashboardQuestion);
    clearQuestionParamFromUrl();
    void sendQuestion(pendingDashboardQuestion);
  }, [clearQuestionParamFromUrl, pendingDashboardQuestion, sendQuestion]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitComposerQuestion();
  };

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsSending(false);
  };

  const copyAnswer = async (text: string) => {
    if (!text.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setGlobalError("Copie impossible sur ce navigateur.");
    }
  };

  const pushUiMessage = useCallback((message: string) => {
    setUiMessage(message);
    window.setTimeout(() => {
      setUiMessage((current) => (current === message ? "" : current));
    }, 2400);
  }, []);

  const exportPdfDocument = useCallback((title: string, content: string) => {
    const finalContent = content.trim();
    if (!finalContent) {
      setGlobalError("Aucun contenu a exporter.");
      return;
    }
    const generatedAt = new Date().toLocaleString("fr-FR");
    const blocks = buildStructuredDocumentBlocks(finalContent);
    const safeFileName = `${toSafeFileName(title)}.pdf`;
    const disclaimer = "Ce document est un modele genere automatiquement et doit etre verifie par un professionnel du droit avant utilisation.";

    try {
      const doc = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4"
      });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const left = 18;
      const right = 18;
      const top = 16;
      const bottom = 16;
      const contentWidth = pageWidth - left - right;

      let y = top;

      const ensureSpace = (requiredHeight: number) => {
        if (y + requiredHeight <= pageHeight - bottom) {
          return;
        }
        doc.addPage();
        y = top;
      };

      const drawWrappedText = (
        text: string,
        fontSize: number,
        lineHeight: number,
        options: { bold?: boolean; color?: [number, number, number]; indent?: number } = {}
      ) => {
        const drawX = left + (options.indent ?? 0);
        const maxWidth = contentWidth - (options.indent ?? 0);
        const lines = doc.splitTextToSize(text, maxWidth);
        const required = lines.length * lineHeight;
        ensureSpace(required + 1);
        doc.setFont("helvetica", options.bold ? "bold" : "normal");
        doc.setFontSize(fontSize);
        if (options.color) {
          doc.setTextColor(options.color[0], options.color[1], options.color[2]);
        } else {
          doc.setTextColor(31, 41, 55);
        }
        doc.text(lines, drawX, y);
        y += required;
      };

      doc.setDrawColor(33, 200, 83);
      doc.setLineWidth(0.6);
      doc.line(left, y, pageWidth - right, y);
      y += 6;

      drawWrappedText("Juridique SN", 10, 4.6, { bold: true, color: [33, 200, 83] });
      y += 1;
      drawWrappedText(title, 16, 6.5, { bold: true, color: [15, 23, 42] });
      y += 1;
      drawWrappedText(`Document genere le ${generatedAt}`, 9.5, 4.4, { color: [107, 114, 128] });
      y += 4;

      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(0.3);
      doc.line(left, y, pageWidth - right, y);
      y += 6;

      for (const block of blocks) {
        if (block.kind === "h1") {
          drawWrappedText(block.text, 14, 6.2, { bold: true, color: [15, 23, 42] });
          y += 2.5;
          continue;
        }
        if (block.kind === "h2") {
          drawWrappedText(block.text, 12.5, 5.6, { bold: true, color: [15, 23, 42] });
          y += 2;
          continue;
        }
        if (block.kind === "h3") {
          drawWrappedText(block.text, 11.5, 5.2, { bold: true, color: [17, 24, 39] });
          y += 1.8;
          continue;
        }
        if (block.kind === "li") {
          drawWrappedText(`• ${block.text}`, 10.5, 4.8, { indent: 2 });
          y += 1.2;
          continue;
        }
        drawWrappedText(block.text, 10.8, 5.0);
        y += 1.8;
      }

      y += 4;
      ensureSpace(16);
      doc.setDrawColor(229, 231, 235);
      doc.line(left, y, pageWidth - right, y);
      y += 5;
      drawWrappedText(disclaimer, 9.5, 4.5, { color: [75, 85, 99] });

      const pageCount = doc.getNumberOfPages();
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        doc.setPage(pageNumber);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(156, 163, 175);
        doc.text(
          `Page ${pageNumber}/${pageCount}`,
          pageWidth - right,
          pageHeight - 8,
          { align: "right" }
        );
      }

      doc.save(safeFileName);
      pushUiMessage("Document exporte.");
    } catch {
      setGlobalError("Export du document impossible.");
    }
  }, [pushUiMessage]);

  const exportTurnDocument = useCallback((turn: Turn) => {
    const title = (turn.displayQuestion ?? turn.question).trim() || "Document juridique";
    exportPdfDocument(title, turn.answer);
  }, [exportPdfDocument]);

  const exportPopupActDocument = useCallback(() => {
    const title = `${activeActTemplate.label} - version finale`;
    exportPdfDocument(title, actGeneratedDocument);
  }, [actGeneratedDocument, activeActTemplate.label, exportPdfDocument]);

  const stopRecorderStream = useCallback(() => {
    const stream = recorderStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    recorderStreamRef.current = null;
  }, []);

  const stopVoiceCapture = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }
    stopRecorderStream();
    recorderRef.current = null;
    setIsRecording(false);
  }, [stopRecorderStream]);

  const handleVoiceCapture = useCallback(async () => {
    if (isTranscribing) {
      return;
    }
    if (isRecording) {
      stopVoiceCapture();
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setGlobalError("La reconnaissance vocale n'est pas supportee sur ce navigateur.");
      return;
    }

    setGlobalError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorderStreamRef.current = stream;
      recorderChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          recorderChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setGlobalError("Erreur pendant l'enregistrement audio.");
        setIsRecording(false);
        stopRecorderStream();
        recorderRef.current = null;
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        stopRecorderStream();
        const chunks = recorderChunksRef.current;
        recorderChunksRef.current = [];
        recorderRef.current = null;
        if (!chunks.length) {
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          return;
        }

        setIsTranscribing(true);
        try {
          const transcript = await transcribeSpeechApi(blob);
          setInput((previous) => {
            const base = previous.trim();
            return base.length > 0 ? `${base} ${transcript}` : transcript;
          });
          pushUiMessage("Transcription ajoutee.");
        } catch (error) {
          const detail =
            error instanceof Error
              ? error.message
              : "Transcription vocale impossible pour le moment.";
          setGlobalError(detail);
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start(250);
      setIsRecording(true);
    } catch {
      setGlobalError("Acces au microphone refuse.");
      setIsRecording(false);
      stopRecorderStream();
      recorderRef.current = null;
    }
  }, [isRecording, isTranscribing, pushUiMessage, stopRecorderStream, stopVoiceCapture]);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopRecorderStream();
      recorderRef.current = null;
    };
  }, [stopRecorderStream]);

  const handleStartNewChat = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    stopVoiceCapture();
    setIsTranscribing(false);
    autoSubmittedRef.current = "";
    setIsSending(false);
    isUploadingComposerFilesRef.current = false;
    setIsUploadingComposerFiles(false);
    setTurns([]);
    setActiveSessionId(`session-${Date.now()}`);
    setActiveSessionCreatedAt(new Date().toISOString());
    setInput("");
    setPendingComposerFiles([]);
    setPendingComposerFileIdsByKey({});
    setGlobalError("");
    setIsMobileLeftPanelOpen(false);
    setIsMobileRightPanelOpen(false);
    setIsWorkspacePanelOpen(false);
    setHasAutoOpenedWorkspacePanel(false);
    setHasDismissedWorkspacePanel(false);
    setRightPanelTab("workspace");
    clearQuestionParamFromUrl();
    pushUiMessage("Nouvelle session demarree.");
  }, [clearQuestionParamFromUrl, pushUiMessage, stopVoiceCapture]);

  const handleOpenHistorySession = useCallback((session: ConsultationRecord) => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    stopVoiceCapture();
    setIsTranscribing(false);
    setIsSending(false);
    isUploadingComposerFilesRef.current = false;
    setIsUploadingComposerFiles(false);

    const parsed = parseSessionPayload(session.answer);
    let restoredTurns: Turn[] = [];
    if (parsed?.turns?.length) {
      restoredTurns = parsed.turns;
    } else {
      const fallbackQuestion = String(session.question ?? "").trim();
      const fallbackAnswer = String(session.answer ?? "").trim();
      if (fallbackQuestion || fallbackAnswer) {
        restoredTurns = [
          {
            id: `turn-restored-${Date.now()}`,
            question: fallbackQuestion || "Question",
            displayQuestion: fallbackQuestion || "Question",
            answer: fallbackAnswer,
            reasoning: "",
            status: session.status === "error" ? "error" : "done",
            ragSources: [],
            ragNote: String(session.ragNote ?? ""),
            finishReason: String(session.finishReason ?? ""),
          },
        ];
      }
    }

    setActiveSessionId(session.id);
    setActiveSessionCreatedAt(session.createdAt);
    setTurns(restoredTurns);
    setInput("");
    setPendingComposerFiles([]);
    setPendingComposerFileIdsByKey({});
    setGlobalError("");
    setIsMobileLeftPanelOpen(false);
    setIsMobileRightPanelOpen(false);
    setWorkspaceSelectedTurnId(restoredTurns.length > 0 ? restoredTurns[restoredTurns.length - 1].id : null);
    pushUiMessage("Session chargee.");
  }, [pushUiMessage, stopVoiceCapture]);

  const handleClearHistory = useCallback(async () => {
    if (sessionHistory.length === 0) {
      return;
    }
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Supprimer tout l'historique des consultations ?");
      if (!confirmed) {
        return;
      }
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsSending(false);
    isUploadingComposerFilesRef.current = false;
    setIsUploadingComposerFiles(false);
    setTurns([]);
    setInput("");
    setPendingComposerFiles([]);
    setPendingComposerFileIdsByKey({});
    setGlobalError("");
    persistedSessionFingerprintRef.current.clear();
    autoSubmittedRef.current = "";
    try {
      await clearConsultationsApi();
      setSessionHistory([]);
      pushUiMessage("Historique supprime.");
    } catch {
      pushUiMessage("Historique local supprime.");
    }
  }, [pushUiMessage, sessionHistory.length]);

  const openActGenerator = useCallback((preferredTemplateType?: string) => {
    if (!requireSignedIn("Connexion requise pour generer un acte.")) {
      return;
    }
    const targetTemplate = resolveActTemplate(preferredTemplateType || initialActTemplateId);
    setActType(targetTemplate.type);
    setActValues(buildInitialActFormValues(targetTemplate));
    setActUserIntent("");
    setActStep(1);
    setActFieldError("");
    setActMissingItems([]);
    setActGeneratedDocument("");
    setActValidationError("");
    setIsActValidating(false);
    setIsPopupChatSending(false);
    setPopupChatInput("");
    setPopupChatMessages([
      {
        id: `popup-${Date.now()}`,
        role: "assistant",
        content:
          "Je suis pret a vous aider a rediger l'acte. Remplissez le formulaire puis utilisez ce mini chat pour completer/valider avant export PDF.",
      },
    ]);
    setIsActGeneratorOpen(true);
  }, [initialActTemplateId, requireSignedIn, resolveActTemplate]);

  useEffect(() => {
    if (autoOpenActGenerator && !autoActOpenedRef.current) {
      autoActOpenedRef.current = true;
      openActGenerator(initialActTemplateId);
    }
  }, [autoOpenActGenerator, initialActTemplateId, openActGenerator]);

  const uploadPendingComposerFiles = useCallback(async (filesToUpload?: File[]): Promise<{ ok: boolean; uploadedFileIds: string[] }> => {
    const targetFiles = (filesToUpload ?? pendingComposerFiles).filter(
      (file) => file instanceof File
    );
    if (targetFiles.length === 0) {
      return { ok: true, uploadedFileIds: [] };
    }
    if (isUploadingComposerFilesRef.current) {
      return { ok: false, uploadedFileIds: [] };
    }
    isUploadingComposerFilesRef.current = true;
    setIsUploadingComposerFiles(true);
    try {
      const response = await uploadWorkspaceFilesApi(targetFiles);
      setWorkspaceFiles(response.items);

      const uploadedCount = response.uploaded?.length ?? 0;
      const uploadedChunkCount = (response.uploaded ?? []).reduce(
        (sum, row) => sum + Number(row.chunk_count || 0),
        0
      );
      const errors = response.errors ?? [];
      const failedFileNames = new Set(
        errors
          .map((row) => (row.filename ?? "").trim().toLowerCase())
          .filter((name) => name.length > 0)
      );

      const nextFileIdsByKey: Record<string, string> = {
        ...pendingComposerFileIdsByKey,
      };
      let uploadedCursor = 0;
      for (const file of targetFiles) {
        const fileKey = composerFileKey(file);
        const normalizedName = file.name.trim().toLowerCase();
        if (failedFileNames.has(normalizedName)) {
          delete nextFileIdsByKey[fileKey];
          continue;
        }
        const uploadedRow = response.uploaded?.[uploadedCursor];
        if (uploadedRow && String(uploadedRow.id ?? "").trim().length > 0) {
          nextFileIdsByKey[fileKey] = String(uploadedRow.id).trim();
          uploadedCursor += 1;
        }
      }
      setPendingComposerFileIdsByKey(nextFileIdsByKey);
      const uploadedFileIds = targetFiles
        .map((file) => nextFileIdsByKey[composerFileKey(file)] ?? "")
        .map((row) => row.trim())
        .filter((row) => row.length > 0);

      if (uploadedCount === 0 && errors.length > 0) {
        setGlobalError(
          errors
            .map((row) => `${row.filename}: ${row.detail}`)
            .slice(0, 3)
            .join(" | ")
        );
        return { ok: false, uploadedFileIds: [] };
      }

      if (uploadedCount > 0) {
        pushUiMessage(
          `${uploadedCount} fichier(s) ajoute(s) au workspace (${uploadedChunkCount} chunk(s)).`
        );
      }

      if (errors.length > 0) {
        setGlobalError(
          errors
            .map((row) => `${row.filename}: ${row.detail}`)
            .slice(0, 2)
            .join(" | ")
        );
      }
      if (uploadedFileIds.length === 0) {
        setGlobalError("Aucun chunk genere pour les fichiers joints.");
        return { ok: false, uploadedFileIds: [] };
      }
      return { ok: true, uploadedFileIds };
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Import des fichiers impossible pour le moment.";
      setGlobalError(detail);
      return { ok: false, uploadedFileIds: [] };
    } finally {
      isUploadingComposerFilesRef.current = false;
      setIsUploadingComposerFiles(false);
    }
  }, [pendingComposerFileIdsByKey, pendingComposerFiles, pushUiMessage]);

  const handleLandingSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSending || isUploadingComposerFiles) {
        return;
      }
      const trimmed = landingQuery.trim();
      const attachedFileNames = pendingComposerFiles.map((file) => file.name);
      const canSubmit = trimmed.length > 0 || attachedFileNames.length > 0;
      if (!canSubmit) {
        return;
      }
      const preUploadedFileIds = pendingComposerFiles
        .map((file) => pendingComposerFileIdsByKey[composerFileKey(file)] ?? "")
        .map((row) => row.trim())
        .filter((row) => row.length > 0);
      const missingFiles = pendingComposerFiles.filter(
        (file) => !pendingComposerFileIdsByKey[composerFileKey(file)]
      );
      let missingUploadIds: string[] = [];
      if (missingFiles.length > 0) {
        const uploadResult = await uploadPendingComposerFiles(missingFiles);
        if (!uploadResult.ok) {
          return;
        }
        missingUploadIds = uploadResult.uploadedFileIds;
      }
      const scopedWorkspaceFileIds = Array.from(
        new Set([...preUploadedFileIds, ...missingUploadIds].filter((row) => row.length > 0))
      );
      if (pendingComposerFiles.length > 0 && scopedWorkspaceFileIds.length === 0) {
        setGlobalError("Aucun fichier n'a pu etre traite.");
        return;
      }
      const workspaceOnly = trimmed.length === 0 && scopedWorkspaceFileIds.length > 0;
      const questionToSend = workspaceOnly
        ? WORKSPACE_ONLY_AUTO_PROMPT
        : trimmed;
      const displayQuestion = buildQuestionDisplayLabel(
        questionToSend,
        attachedFileNames,
        workspaceOnly
      );
      setInput(questionToSend);
      setLandingQuery("");
      await sendQuestion(questionToSend, {
        displayQuestion,
        disableRagRewrite: workspaceOnly,
        workspaceOnly,
        workspaceFileIds: scopedWorkspaceFileIds,
      });
      setPendingComposerFiles([]);
      setPendingComposerFileIdsByKey({});
    },
    [
      isSending,
      isUploadingComposerFiles,
      landingQuery,
      pendingComposerFileIdsByKey,
      pendingComposerFiles,
      sendQuestion,
      uploadPendingComposerFiles,
    ]
  );

  const handleOpenWorkspacePanel = useCallback(() => {
    if (!requireSignedIn("Connexion requise pour ouvrir le workspace.")) {
      return;
    }
    setIsWorkspacePanelOpen(true);
    setRightPanelTab("workspace");
  }, [requireSignedIn]);

  const handleCloseWorkspacePanel = useCallback(() => {
    setIsWorkspacePanelOpen(false);
    setIsMobileRightPanelOpen(false);
    setHasDismissedWorkspacePanel(true);
  }, []);

  useEffect(() => {
    if (!hasGeneratedResponse) {
      return;
    }
    if (hasAutoOpenedWorkspacePanel || hasDismissedWorkspacePanel) {
      return;
    }
    setIsWorkspacePanelOpen(true);
    setHasAutoOpenedWorkspacePanel(true);
  }, [hasAutoOpenedWorkspacePanel, hasDismissedWorkspacePanel, hasGeneratedResponse]);

  const closeActGenerator = useCallback(() => {
    if (actGenerationProgressResetTimerRef.current !== null) {
      window.clearTimeout(actGenerationProgressResetTimerRef.current);
      actGenerationProgressResetTimerRef.current = null;
    }
    setIsActGeneratorOpen(false);
    setActStep(1);
    setActFieldError("");
    setActMissingItems([]);
    setActGeneratedDocument("");
    setActValidationError("");
    setIsActValidating(false);
    setActGenerationProgressPercent(0);
    setIsPopupChatSending(false);
    setPopupChatInput("");
    setPopupChatMessages([]);
  }, []);

  const handleActTypeChange = useCallback((nextType: ActType) => {
    const nextTemplate = actTemplateMap.get(nextType);
    if (!nextTemplate) {
      return;
    }
    setActType(nextType);
    setActValues(buildInitialActFormValues(nextTemplate));
    setActFieldError("");
    setActMissingItems([]);
    setActGeneratedDocument("");
    setActValidationError("");
    setActGenerationProgressPercent(0);
  }, [actTemplateMap]);

  const handleActFieldChange = useCallback((fieldKey: string, nextValue: string) => {
    setActFieldError("");
    setActValidationError("");
    setActMissingItems([]);
    setActGeneratedDocument("");
    setActGenerationProgressPercent(0);
    setActValues((previous) => ({ ...previous, [fieldKey]: nextValue }));
  }, []);

  const handleActStepOneContinue = useCallback(() => {
    setActStep(2);
  }, []);

  const handleActPrevious = useCallback(() => {
    if (actStep === 3) {
      setActStep(2);
      return;
    }
    if (actStep === 2) {
      setActStep(1);
    }
  }, [actStep]);

  const runActAssistant = useCallback(
    async (userMessage: string, mode: "chat" | "validate") => {
      if (!requireSignedIn("Connexion requise pour utiliser le mini chat de redaction.")) {
        return;
      }
      const trimmedUserMessage = userMessage.trim();
      if (!trimmedUserMessage) {
        return;
      }
      if (mode === "chat" && isPopupChatSending) {
        return;
      }
      if (mode === "validate" && isActValidating) {
        return;
      }

      setActValidationError("");
      const conversationForPrompt: PopupChatMessage[] = [
        ...popupChatMessages,
        {
          id: `popup-user-shadow-${Date.now()}`,
          role: "user",
          content: trimmedUserMessage,
        },
      ];
      setPopupChatMessages((previous) => [
        ...previous,
        {
          id: `popup-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "user",
          content: trimmedUserMessage,
        },
      ]);

      if (mode === "chat") {
        setIsPopupChatSending(true);
      } else {
        if (actGenerationProgressResetTimerRef.current !== null) {
          window.clearTimeout(actGenerationProgressResetTimerRef.current);
          actGenerationProgressResetTimerRef.current = null;
        }
        setActGenerationProgressPercent(8);
        setIsActValidating(true);
      }

      const prompt = buildActValidationPrompt(
        activeActTemplate,
        actValues,
        actUserIntent,
        actGeneratedDocument,
        conversationForPrompt,
        trimmedUserMessage
      );
      try {
        const response = await fetch(`${backendBaseUrl}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            top_p: 0.95,
            max_tokens: 1800,
            thinking: false,
            use_rag: mode === "validate",
            rag_query_rewrite: false,
          }),
        });

        const rawBody = await response.text();
        let parsedPayload: unknown = null;
        if (rawBody.trim().length > 0) {
          try {
            parsedPayload = JSON.parse(rawBody);
          } catch {
            parsedPayload = rawBody;
          }
        }

        if (!response.ok) {
          const detailFromPayload =
            parsedPayload && typeof parsedPayload === "object"
              ? String(
                  ((parsedPayload as Record<string, unknown>).detail as string | undefined) ??
                    ""
                ).trim()
              : "";
          const fallback = detailFromPayload || `Erreur HTTP ${response.status}`;
          setActValidationError(fallback);
          setPopupChatMessages((previous) => [
            ...previous,
            {
              id: `popup-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: "assistant",
              content: fallback,
            },
          ]);
          return;
        }

        let answer = "";
        if (typeof parsedPayload === "string") {
          answer = parsedPayload.trim();
        } else {
          answer = extractAssistantTextFromChatPayload(parsedPayload);
        }
        if (!answer) {
          const debugRaw =
            typeof parsedPayload === "string"
              ? parsedPayload.slice(0, 320)
              : JSON.stringify(parsedPayload ?? {}).slice(0, 320);
          const detail =
            `Le generateur n'a retourne aucune reponse exploitable (reponse vide ou format inattendu). ` +
            `Extrait brut: ${debugRaw || "[vide]"}`;
          setActValidationError(detail);
          setPopupChatMessages((previous) => [
            ...previous,
            {
              id: `popup-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: "assistant",
              content: detail,
            },
          ]);
          return;
        }

        const parsed = parseActValidationResponse(answer);
        const requiredFields = activeActTemplate.fields.filter((field) => field.required);
        const requiredFieldLabels = requiredFields.map((field) => field.label);
        const requiredLabelsNormalized = requiredFieldLabels.map((label) => normalizeForMatch(label));
        const fallbackMissing = requiredFields
          .filter((field) => (actValues[field.key] ?? "").trim().length === 0)
          .map((field) => field.label);
        const missingRequiredFromModel = parsed.missingItems.filter((item) => {
          const normalizedItem = normalizeForMatch(item);
          if (!normalizedItem) {
            return false;
          }
          return requiredLabelsNormalized.some(
            (requiredLabel) =>
              normalizedItem === requiredLabel ||
              normalizedItem.includes(requiredLabel) ||
              requiredLabel.includes(normalizedItem)
          );
        });
        const blockingMissing =
          missingRequiredFromModel.length > 0 ? missingRequiredFromModel : fallbackMissing;
        const shouldBlockForMissing = blockingMissing.length > 0;
        const assistantReply = shouldBlockForMissing
          ? (
              parsed.assistantReply.trim() ||
              "Il manque des informations obligatoires pour finaliser l'acte."
            )
          : (
              parsed.assistantReply.trim() ||
              "Toutes les informations obligatoires sont presentes. Document final pret."
            );

        setPopupChatMessages((previous) => [
          ...previous,
          {
            id: `popup-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "assistant",
            content: assistantReply,
          },
        ]);

        if (shouldBlockForMissing) {
          setActMissingItems(blockingMissing);
          setActGeneratedDocument("");
          return;
        }

        setActMissingItems([]);
        const nextDocumentText = parsed.documentText.trim();
        if (nextDocumentText.length > 0) {
          setActGeneratedDocument(nextDocumentText);
          pushUiMessage("Acte genere dans la previsualisation.");
        } else if (actGeneratedDocument.trim().length > 0) {
          // Keep the current compliant draft when the model refuses a requested change.
          setActGeneratedDocument(actGeneratedDocument.trim());
        } else {
          setActValidationError(
            "Le modele n'a pas fourni de document final. Precisez davantage les informations."
          );
        }
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "Generation impossible pour le moment.";
        setActValidationError(detail);
        setPopupChatMessages((previous) => [
          ...previous,
          {
            id: `popup-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "assistant",
            content: detail,
          },
        ]);
      } finally {
        if (mode === "chat") {
          setIsPopupChatSending(false);
        } else {
          setActGenerationProgressPercent(100);
          setIsActValidating(false);
          actGenerationProgressResetTimerRef.current = window.setTimeout(() => {
            setActGenerationProgressPercent((previous) => (previous >= 100 ? 0 : previous));
            actGenerationProgressResetTimerRef.current = null;
          }, 900);
        }
      }
    },
    [
      actUserIntent,
      actValues,
      activeActTemplate,
      actGeneratedDocument,
      backendBaseUrl,
      isActValidating,
      isPopupChatSending,
      popupChatMessages,
      pushUiMessage,
      requireSignedIn,
    ]
  );

  const handleActValidateAndGenerate = useCallback(async () => {
    await runActAssistant(
      "Valide les informations saisies. Si elles sont insuffisantes, demande uniquement les informations manquantes. Sinon redige l'acte final complet.",
      "validate"
    );
  }, [runActAssistant]);

  const handleActNext = useCallback(() => {
    if (actStep !== 2) {
      return;
    }
    setActStep(3);
    void handleActValidateAndGenerate();
  }, [actStep, handleActValidateAndGenerate]);

  const handlePopupChatSubmit = useCallback(async () => {
    const message = popupChatInput.trim();
    if (!message || isPopupChatSending) {
      return;
    }
    setPopupChatInput("");
    await runActAssistant(message, "chat");
  }, [isPopupChatSending, popupChatInput, runActAssistant]);

  const handleComposerFilesSelected = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) {
        return;
      }
      if (isUploadingComposerFilesRef.current) {
        setGlobalError("Patientez: un upload de document est deja en cours.");
        return;
      }
      const files = Array.from(fileList);
      const existingKeys = new Set(pendingComposerFiles.map((file) => composerFileKey(file)));
      const freshFiles = files.filter((file) => !existingKeys.has(composerFileKey(file)));
      if (freshFiles.length === 0) {
        return;
      }
      setPendingComposerFiles((previous) => dedupeComposerFiles([...previous, ...freshFiles]));
      pushUiMessage(`${freshFiles.length} fichier(s) joint(s) a la question.`);
      void uploadPendingComposerFiles(freshFiles);
    },
    [pendingComposerFiles, pushUiMessage, uploadPendingComposerFiles]
  );

  const removePendingComposerFile = useCallback((fileKey: string) => {
    setPendingComposerFiles((previous) =>
      previous.filter((file) => composerFileKey(file) !== fileKey)
    );
    setPendingComposerFileIdsByKey((previous) => {
      const next = { ...previous };
      delete next[fileKey];
      return next;
    });
  }, []);

  const submitComposerQuestion = useCallback(async () => {
    const trimmed = input.trim();
    const attachedFileNames = pendingComposerFiles.map((file) => file.name);
    const canSubmit = trimmed.length > 0 || attachedFileNames.length > 0;
    if (!canSubmit || isSending || isUploadingComposerFiles) {
      return;
    }

    const preUploadedFileIds = pendingComposerFiles
      .map((file) => pendingComposerFileIdsByKey[composerFileKey(file)] ?? "")
      .map((row) => row.trim())
      .filter((row) => row.length > 0);
    const missingFiles = pendingComposerFiles.filter(
      (file) => !pendingComposerFileIdsByKey[composerFileKey(file)]
    );
    let missingUploadIds: string[] = [];
    if (missingFiles.length > 0) {
      const uploadResult = await uploadPendingComposerFiles(missingFiles);
      if (!uploadResult.ok) {
        return;
      }
      missingUploadIds = uploadResult.uploadedFileIds;
    }
    const scopedWorkspaceFileIds = Array.from(
      new Set([...preUploadedFileIds, ...missingUploadIds].filter((row) => row.length > 0))
    );
    if (pendingComposerFiles.length > 0 && scopedWorkspaceFileIds.length === 0) {
      setGlobalError("Aucun fichier n'a pu etre traite.");
      return;
    }

    const workspaceOnly = trimmed.length === 0 && scopedWorkspaceFileIds.length > 0;
    const questionToSend = workspaceOnly
      ? WORKSPACE_ONLY_AUTO_PROMPT
      : trimmed;
    const displayQuestion = buildQuestionDisplayLabel(
      questionToSend,
      attachedFileNames,
      workspaceOnly
    );
    await sendQuestion(questionToSend, {
      displayQuestion,
      disableRagRewrite: workspaceOnly,
      workspaceOnly,
      workspaceFileIds: scopedWorkspaceFileIds,
    });
    setPendingComposerFiles([]);
    setPendingComposerFileIdsByKey({});
  }, [
    input,
    isSending,
    isUploadingComposerFiles,
    pendingComposerFileIdsByKey,
    pendingComposerFiles,
    sendQuestion,
    uploadPendingComposerFiles,
  ]);

  const handleComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      if (isSending || isUploadingComposerFiles || (input.trim().length === 0 && pendingComposerFiles.length === 0)) {
        return;
      }
      void submitComposerQuestion();
    },
    [input, isSending, isUploadingComposerFiles, pendingComposerFiles.length, submitComposerQuestion]
  );

  const handleShare = useCallback(async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      pushUiMessage("Lien copie dans le presse-papiers.");
    } catch {
      setGlobalError("Partage impossible sur ce navigateur.");
    }
  }, [pushUiMessage]);

  const handleExport = useCallback(() => {
    window.print();
  }, []);

  const persistWorkspaceSnapshot = useCallback(async () => {
    if (!requireSignedIn("Connexion requise pour synchroniser le workspace.")) {
      return;
    }
    try {
      await Promise.all([
        writeWorkspaceNotesApi(notes),
        writeWorkspaceFilesApi(workspaceFiles),
      ]);
      pushUiMessage("Workspace synchronise.");
    } catch {
      setGlobalError("Synchronisation impossible pour le moment.");
    }
  }, [notes, pushUiMessage, requireSignedIn, workspaceFiles]);

  const handleCitationOpen = useCallback(
    async (card: CitationCard) => {
      if (!requireSignedIn("Connexion requise pour ouvrir une source de la bibliotheque.")) {
        return;
      }
      const rawReference = (card.sourcePath ?? card.meta).trim();
      if (!rawReference) {
        return;
      }

      let documents = libraryDocumentsCacheRef.current;
      if (documents.length === 0) {
        try {
          documents = await listLibraryDocumentsApi();
          if (documents.length > 0) {
            libraryDocumentsCacheRef.current = documents;
          }
        } catch {
          // fallback to copy below
        }
      }

      const matched = resolveCitationDocument(card, documents);
      if (matched) {
        const pageFromCard =
          (typeof card.pageStart === "number" && card.pageStart > 0
            ? card.pageStart
            : parsePageFromCitationText(card.meta) ?? parsePageFromCitationText(card.excerpt)) ?? null;
        const viewUrl = buildLibraryViewUrl(matched.id);
        const targetUrl = pageFromCard ? `${viewUrl}#page=${pageFromCard}` : viewUrl;
        window.location.assign(targetUrl);
        return;
      }

      try {
        await navigator.clipboard.writeText(rawReference);
        pushUiMessage("Source non reliee: reference copiee.");
      } catch {
        setGlobalError("Impossible de copier la reference.");
      }
    },
    [pushUiMessage, requireSignedIn]
  );

  const toggleChunkPreview = useCallback((chunkId: string) => {
    setExpandedChunkIds((previous) => ({
      ...previous,
      [chunkId]: !previous[chunkId],
    }));
  }, []);

  const addWorkspaceFiles = useCallback(async (fileList: FileList | null) => {
    if (!requireSignedIn("Connexion requise pour ajouter des fichiers au workspace.")) {
      return;
    }
    if (!fileList || fileList.length === 0) {
      return;
    }
    try {
      const files = Array.from(fileList);
      const response = await uploadWorkspaceFilesApi(files);
      setWorkspaceFiles(response.items);

      const uploadedCount = response.uploaded?.length ?? 0;
      const uploadedChunkCount = (response.uploaded ?? []).reduce(
        (sum, row) => sum + Number(row.chunk_count || 0),
        0
      );
      const errorCount = response.errors?.length ?? 0;
      if (uploadedCount > 0) {
        pushUiMessage(
          `${uploadedCount} fichier(s) indexe(s) (${uploadedChunkCount} chunk(s)).`
        );
      } else if (errorCount > 0) {
        setGlobalError(
          response.errors
            ?.map((row) => `${row.filename}: ${row.detail}`)
            .slice(0, 3)
            .join(" | ") ?? "Import impossible."
        );
      } else {
        setGlobalError("Aucun chunk genere pour ce fichier.");
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Import impossible pour le moment.";
      setGlobalError(detail);
    }
  }, [pushUiMessage, requireSignedIn]);

  const handleClearWorkspaceFiles = useCallback(async () => {
    if (!requireSignedIn("Connexion requise pour gerer le workspace.")) {
      return;
    }
    const cleared = await clearWorkspaceFilesApi();
    setWorkspaceFiles(cleared);
    pushUiMessage("Fichiers locaux nettoyes.");
  }, [pushUiMessage, requireSignedIn]);

  return (
    <div className="bg-[#112117] dark:bg-[#112117] font-display text-slate-100 flex flex-col min-h-screen lg:h-screen overflow-x-hidden lg:overflow-hidden">
      <SignedOut>
        <SignInButton mode="modal">
          <button ref={signInModalTriggerRef} type="button" className="hidden" aria-hidden="true" />
        </SignInButton>
      </SignedOut>
      <header className="flex items-center gap-4 px-3 sm:px-6 py-3 bg-white dark:bg-[#122118] border-b border-slate-200 dark:border-slate-800 shrink-0 z-20">
        <button
          className="lg:hidden inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 hover:bg-slate-50 dark:hover:bg-[#1e2e24]"
          onClick={() => {
            setIsMobileLeftPanelOpen((previous) => {
              const next = !previous;
              if (next) {
                setIsSidebarCollapsed(false);
              }
              return next;
            });
            setIsMobileRightPanelOpen(false);
          }}
          type="button"
        >
          <span className="material-symbols-outlined text-base">menu</span>
        </button>
        <div className={`${isSidebarCollapsed ? "lg:w-16" : "lg:w-72"} flex items-center gap-2 shrink-0 min-w-0`}>
          <div className="size-8 bg-[#13221a] border border-[#49DE80]/40 rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-[#49DE80] font-bold">gavel</span>
          </div>
          <h1 className={`text-lg font-bold tracking-tight truncate ${isSidebarCollapsed ? "lg:hidden" : ""}`}>
            Juridique <span className="text-[#7ef1a9]">SN</span>
          </h1>
        </div>
        <div className="hidden md:flex items-center gap-4 min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[10px] font-bold text-[#49DE80] uppercase tracking-wider shrink-0">
            <span className="size-2 bg-[#49DE80] rounded-full animate-pulse"></span>
            Actualites
          </span>
          <div className="news-ticker flex-1 overflow-hidden">
            <div className="news-ticker-track text-sm text-slate-400">
              <span className="news-ticker-item pr-16">
                Publication du nouveau decret sur l&apos;amenagement foncier urbain au Journal Officiel...
                | Reforme du Code du Travail : Consultation nationale en cours...
              </span>
              <span aria-hidden="true" className="news-ticker-item pr-16">
                Publication du nouveau decret sur l&apos;amenagement foncier urbain au Journal Officiel...
                | Reforme du Code du Travail : Consultation nationale en cours...
              </span>
            </div>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <SignedOut>
            <Link
              className="inline-flex items-center justify-center rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:border-[#49DE80]/60 hover:text-[#49DE80] transition-colors"
              href="/sign-in"
            >
              Se connecter
            </Link>
            <Link
              className="inline-flex items-center justify-center rounded-lg bg-[#49DE80] px-3 py-1.5 text-sm font-bold text-[#112117] hover:bg-[#3fd273] transition-colors"
              href="/sign-up"
            >
              Creer un compte
            </Link>
          </SignedOut>
          <SignedIn>
            <UserButton afterSignOutUrl="/sign-in" appearance={clerkUserButtonAppearance}>
              <UserButton.MenuItems>
                <UserButton.Link
                  href="/dashboard"
                  label="Dashboard utilisateur"
                  labelIcon={<span className="material-symbols-outlined text-[16px]">space_dashboard</span>}
                />
              </UserButton.MenuItems>
            </UserButton>
          </SignedIn>
        </div>
        <div className="lg:hidden flex items-center gap-2 ml-auto">
          <button
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 hover:bg-slate-50 dark:hover:bg-[#1e2e24]"
            onClick={() => {
              if (isMobileRightPanelOpen) {
                handleCloseWorkspacePanel();
              } else {
                handleOpenWorkspacePanel();
                setIsMobileRightPanelOpen(true);
              }
              setIsMobileLeftPanelOpen(false);
            }}
            type="button"
          >
            <span className="material-symbols-outlined text-base">tune</span>
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {isMobileLeftPanelOpen || isMobileRightPanelOpen ? (
          <button
            aria-label="Fermer les panneaux"
            className="lg:hidden fixed inset-0 z-30 bg-black/45 backdrop-blur-[1px]"
            onClick={() => {
              setIsMobileLeftPanelOpen(false);
              handleCloseWorkspacePanel();
            }}
            type="button"
          />
        ) : null}

        <aside
          className={`${
            isMobileLeftPanelOpen ? "fixed inset-y-0 left-0 z-40 flex w-[84vw] max-w-xs shadow-2xl" : "hidden"
          } lg:static lg:z-auto lg:flex ${isSidebarCollapsed ? "lg:w-16" : "lg:w-72"} border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0c1811] flex-col shrink-0 transition-all duration-300`}
        >
          <div className={isSidebarCollapsed ? "p-2" : "p-6"}>
            <div className={`flex ${isSidebarCollapsed ? "flex-col items-center gap-2" : "items-center justify-between"} mb-6`}>
              <div className={`flex items-center ${isSidebarCollapsed ? "" : "gap-3"}`}>
                <div
                  className={`${isSidebarCollapsed ? "size-9" : "size-10"} bg-[#1a2e22] border border-[#49DE80]/40 rounded-lg flex items-center justify-center shadow-lg shadow-[#49DE80]/10`}
                >
                  <span className="material-symbols-outlined text-[#49DE80] font-bold">gavel</span>
                </div>
                {!isSidebarCollapsed ? (
                  <span className="text-lg font-bold tracking-tight">
                    Juridique <span className="text-[#7ef1a9]">SN</span>
                  </span>
                ) : null}
              </div>
              <button
                aria-label={isSidebarCollapsed ? "Etendre le menu" : "Reduire le menu"}
                className={`hidden lg:inline-flex items-center justify-center rounded-full border border-slate-700/80 bg-slate-900/60 text-slate-300 transition-all hover:border-[#49DE80]/60 hover:bg-[#49DE80]/10 hover:text-[#49DE80] ${
                  isSidebarCollapsed ? "size-8" : "size-9"
                }`}
                onClick={() => setIsSidebarCollapsed((value) => !value)}
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isSidebarCollapsed ? "chevron_right" : "chevron_left"}
                </span>
              </button>
            </div>
            {!isSidebarCollapsed ? (
              <button
                className="flex w-full items-center gap-3 bg-[#49DE80] hover:bg-[#49DE80]/90 text-[#112117] font-semibold py-3 px-4 rounded-xl transition-all mb-8 shadow-lg shadow-[#49DE80]/20"
                onClick={() => {
                  handleStartNewChat();
                  setIsMobileLeftPanelOpen(false);
                }}
                type="button"
              >
                <span className="material-symbols-outlined">add</span>
                Nouvelle Consultation
              </button>
            ) : null}
            <nav className="space-y-1">
              {!isSidebarCollapsed ? (
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-4 px-2">
                  Navigation
                </p>
              ) : null}
              <Link
                className={`flex items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white transition-colors ${
                  isSidebarCollapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"
                }`}
                href="/bibliotheque"
                onClick={() => setIsMobileLeftPanelOpen(false)}
                title="Bibliotheque juridique"
              >
                <span className="material-symbols-outlined">library_books</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Bibliotheque juridique</span> : null}
              </Link>
              <Link
                className={`flex items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white transition-colors ${
                  isSidebarCollapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"
                }`}
                href="/bibliotheque-v2"
                onClick={() => setIsMobileLeftPanelOpen(false)}
                title="Modeles de documents"
              >
                <span className="material-symbols-outlined">description</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Modeles de documents</span> : null}
              </Link>
              <button
                className={`w-full flex items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white transition-colors ${
                  isSidebarCollapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"
                }`}
                onClick={() => {
                  openActGenerator();
                  setIsMobileLeftPanelOpen(false);
                }}
                title="Generer un acte"
                type="button"
              >
                <span className="material-symbols-outlined">history_edu</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Generer un acte</span> : null}
              </button>
            </nav>
          </div>
          {!isSidebarCollapsed ? (
            <>
              <SignedIn>
                <div className="flex-1 overflow-y-auto px-6">
                  <div className="mb-4 px-2 flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase font-bold text-slate-500 tracking-widest">
                      Historique recent
                    </p>
                    <button
                      aria-label="Supprimer l'historique"
                      className="inline-flex items-center justify-center rounded-md p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      disabled={sessionHistory.length === 0}
                      onClick={() => {
                        void handleClearHistory();
                      }}
                      title="Supprimer l'historique"
                      type="button"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                  <div className="space-y-2">
                    {sessionHistory.length === 0 ? (
                      <div className="p-3 rounded-lg border border-slate-800">
                        <p className="text-xs text-slate-500">Aucune consultation enregistree pour le moment.</p>
                      </div>
                    ) : (
                      sessionHistory
                        .slice(0, 20)
                        .map((session) => (
                          <div
                            className="group p-3 rounded-lg hover:bg-white/5 transition-colors border border-transparent hover:border-slate-800"
                            key={session.id}
                          >
                            <div className="flex items-start gap-2">
                              <button
                                className="flex-1 min-w-0 text-left cursor-pointer"
                                onClick={() => {
                                  handleOpenHistorySession(session);
                                }}
                                type="button"
                              >
                                <p className="text-sm font-medium text-slate-200 truncate">
                                  {consultationTitle(session)}
                                </p>
                                <p className="text-xs text-slate-500 mt-1">{formatDateLabel(session.updatedAt)}</p>
                              </button>
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              </SignedIn>
            </>
          ) : null}
        </aside>

        <main className="flex-1 min-w-0 flex flex-col bg-[#112117] dark:bg-[#112117] relative lg:border-r border-slate-200 dark:border-slate-800">
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-8 scroll-smooth no-scrollbar">
            <div className="max-w-3xl mx-auto space-y-8">
              {turns.length === 0 ? (
                <section className="text-center max-w-3xl mx-auto min-h-[calc(100vh-260px)] sm:min-h-[calc(100vh-180px)] md:min-h-[calc(100vh-240px)] flex flex-col justify-center gap-5 md:gap-6 pt-8 md:pt-14">
                  <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
                    Comment puis-je vous <span className="text-primary">aider</span> aujourd&apos;hui ?
                  </h2>
                  <p className="text-base md:text-lg text-slate-400">
                    Accedez instantanement au droit senegalais. Posez vos questions sur le COCC, le Code du Travail ou les procedures administratives.
                  </p>
                  <form className="relative group hidden sm:block" onSubmit={handleLandingSubmit}>
                    {pendingComposerFiles.length > 0 ? (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {pendingComposerFiles.map((file) => {
                          const key = composerFileKey(file);
                          return (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-slate-200"
                              key={key}
                            >
                              <span className="material-symbols-outlined text-[13px] text-primary">description</span>
                              <span className="max-w-[220px] truncate">{file.name}</span>
                              <button
                                className={`inline-flex items-center justify-center rounded-full ${
                                  isUploadingComposerFiles
                                    ? "text-slate-600 cursor-not-allowed"
                                    : "text-slate-400 hover:text-red-400"
                                }`}
                                disabled={isUploadingComposerFiles}
                                onClick={() => removePendingComposerFile(key)}
                                type="button"
                              >
                                <span className="material-symbols-outlined text-[14px]">close</span>
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {isUploadingComposerFiles ? (
                      <div className="mb-3 flex items-center gap-2 text-xs text-slate-300">
                        <span className="material-symbols-outlined animate-spin text-[15px] text-primary">autorenew</span>
                        Chargement du document en cours...
                      </div>
                    ) : null}
                    <div className="absolute inset-y-0 left-5 flex items-center gap-2">
                      <span className="material-symbols-outlined text-slate-400 group-focus-within:text-primary transition-colors pointer-events-none">
                        search
                      </span>
                      <button
                        className={`inline-flex items-center justify-center rounded-lg p-1 transition-colors ${
                          isUploadingComposerFiles
                            ? "text-slate-600 cursor-not-allowed"
                            : "text-slate-400 hover:text-primary"
                        }`}
                        disabled={isUploadingComposerFiles}
                        onClick={() => landingFileInputRef.current?.click()}
                        type="button"
                      >
                        <span className="material-symbols-outlined text-[18px]">attach_file</span>
                      </button>
                    </div>
                    <input
                      accept=".pdf,.doc,.docx,.txt,.md"
                      className="hidden"
                      multiple
                      onChange={(event) => {
                        handleComposerFilesSelected(event.target.files);
                        event.currentTarget.value = "";
                      }}
                      ref={landingFileInputRef}
                      type="file"
                    />
                    <input
                      className="w-full bg-[#1a2e22] border-slate-800 focus:border-primary focus:ring-1 focus:ring-primary rounded-2xl py-4 sm:py-5 pl-20 sm:pl-24 pr-4 sm:pr-24 text-base sm:text-lg text-white placeholder:text-slate-400 shadow-2xl transition-all"
                      onChange={(event) => setLandingQuery(event.target.value)}
                      placeholder="Decrivez votre situation juridique..."
                      type="text"
                      value={landingQuery}
                    />
                    <div className="mt-3 sm:mt-0 sm:absolute sm:inset-y-2 sm:right-2 flex items-center justify-end">
                      <button
                        className="w-full sm:w-auto bg-[#49DE80] hover:bg-[#49DE80]/90 text-[#112117] font-bold px-4 h-11 sm:h-full rounded-xl transition-colors inline-flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={isSending || isUploadingComposerFiles || (landingQuery.trim().length === 0 && pendingComposerFiles.length === 0)}
                        type="submit"
                      >
                        <span className={`material-symbols-outlined filled text-[18px] ${isUploadingComposerFiles ? "animate-spin" : ""}`}>
                          {isUploadingComposerFiles ? "autorenew" : "north"}
                        </span>
                      </button>
                    </div>
                  </form>
                  <div className="w-full pt-2 space-y-3 text-center sm:text-left">
                    <div className="flex items-end justify-center sm:justify-between">
                      <div>
                        <h3 className="text-base font-bold">Domaines d&apos;expertise</h3>
                        <p className="text-xs text-slate-500">
                          Parcourez les principales branches du droit senegalais
                        </p>
                      </div>
                      <button
                        className="hidden sm:inline text-[#49DE80] text-sm font-semibold hover:underline"
                        onClick={() => router.push("/bibliotheque")}
                        type="button"
                      >
                        Voir tout
                      </button>
                    </div>
                    <div className="sm:hidden space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        {expertiseDomains.slice(0, 3).map((domain) => (
                          <button
                            className="bg-[#1a2e22] px-2 py-2 rounded-lg border border-slate-800 text-center hover:border-primary/40 transition-colors"
                            key={domain.title}
                            onClick={() => router.push(domain.href)}
                            type="button"
                          >
                            <div
                              className={`size-5 rounded-md flex items-center justify-center mb-1 mx-auto border ${
                                domain.tone === "blue"
                                  ? "bg-gradient-to-br from-blue-500/25 to-blue-500/5 text-blue-300 border-blue-400/25"
                                  : domain.tone === "orange"
                                    ? "bg-gradient-to-br from-orange-500/25 to-orange-500/5 text-orange-300 border-orange-400/25"
                                    : "bg-gradient-to-br from-cyan-500/25 to-cyan-500/5 text-cyan-300 border-cyan-400/25"
                              }`}
                            >
                              <span className="material-symbols-outlined filled text-[11px]">{domain.icon}</span>
                            </div>
                            <h4 className="font-semibold text-[10px] leading-tight">{domain.shortTitle}</h4>
                          </button>
                        ))}
                      </div>
                      <div className="flex justify-center">
                        <button
                          className="w-[32%] min-w-[104px] max-w-[132px] bg-[#1a2e22] px-2 py-2 rounded-lg border border-slate-800 text-center hover:border-primary/40 transition-colors"
                          onClick={() => router.push(expertiseDomains[3].href)}
                          type="button"
                        >
                          <div className="size-5 rounded-md flex items-center justify-center mb-1 mx-auto border bg-gradient-to-br from-[#49DE80]/25 to-[#49DE80]/5 text-[#7ef1a9] border-[#49DE80]/30">
                            <span className="material-symbols-outlined filled text-[11px]">corporate_fare</span>
                          </div>
                          <h4 className="font-semibold text-[10px] leading-tight">Affaires</h4>
                        </button>
                      </div>
                      <button
                        className="text-[#49DE80] text-xs font-semibold hover:underline"
                        onClick={() => router.push("/bibliotheque")}
                        type="button"
                      >
                        Voir tout
                      </button>
                    </div>
                    <div className="hidden sm:grid grid-cols-2 lg:grid-cols-4 gap-3">
                      {expertiseDomains.map((domain) => (
                        <button
                          className="bg-[#1a2e22] p-3 rounded-lg border border-slate-800 hover:border-primary/40 transition-all group cursor-pointer shadow-sm text-left"
                          key={domain.title}
                          onClick={() => router.push(domain.href)}
                          type="button"
                        >
                          <div
                            className={`size-7 rounded-md flex items-center justify-center mb-2 border transition-transform group-hover:scale-105 ${
                              domain.tone === "blue"
                                ? "bg-gradient-to-br from-blue-500/25 to-blue-500/5 text-blue-300 border-blue-400/25"
                                : domain.tone === "orange"
                                  ? "bg-gradient-to-br from-orange-500/25 to-orange-500/5 text-orange-300 border-orange-400/25"
                                  : domain.tone === "teal"
                                    ? "bg-gradient-to-br from-cyan-500/25 to-cyan-500/5 text-cyan-300 border-cyan-400/25"
                                    : "bg-gradient-to-br from-[#49DE80]/25 to-[#49DE80]/5 text-[#7ef1a9] border-[#49DE80]/30"
                            }`}
                          >
                            <span className="material-symbols-outlined filled text-[14px]">{domain.icon}</span>
                          </div>
                          <h4 className="font-semibold text-xs mb-1">{domain.title}</h4>
                          <p className="text-[11px] text-slate-400 leading-snug">{domain.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              ) : null}

              {turns.map((turn) => (
                <div className="space-y-6" key={turn.id}>
                  <div className="flex items-start gap-4 justify-end">
                    <div className="flex flex-col items-end max-w-[80%]">
                      <div className="bg-[#21DF6C] text-black px-5 py-3 rounded-2xl rounded-tr-sm shadow-md font-medium">
                        {turn.displayQuestion ?? turn.question}
                      </div>
                      <span className="text-[10px] text-slate-400 mt-2">{nowTimeLabel()} - Lu</span>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="size-9 rounded-full bg-primary/20 flex items-center justify-center shrink-0 border border-primary/30">
                      <span className="material-symbols-outlined text-primary text-xl">smart_toy</span>
                    </div>
                    <div className="flex flex-col items-start max-w-[85%]">
                      <div className="bg-white dark:bg-[#1e2e24] text-slate-900 dark:text-slate-100 px-6 py-5 rounded-2xl rounded-tl-sm shadow-sm border border-slate-200 dark:border-slate-800">
                        {turn.answer.trim().length > 0 ? (
                          renderAnswerContent(turn.answer)
                        ) : (
                          <p className="leading-relaxed">Analyse en cours...</p>
                        )}
                      </div>
                      <div className="flex gap-4 mt-2 ml-1">
                        <button
                          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-primary transition-colors"
                          onClick={() => copyAnswer(turn.answer)}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-sm">content_copy</span> Copier
                        </button>
                        {isActGenerationPrompt(turn.question) ? (
                          <button
                            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-primary transition-colors disabled:opacity-50"
                            disabled={turn.answer.trim().length === 0}
                            onClick={() => exportTurnDocument(turn)}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-sm">download</span> Exporter document
                          </button>
                        ) : null}
                        <button
                          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-primary transition-colors disabled:opacity-50"
                          disabled={isSending}
                          onClick={() => sendQuestion(turn.question)}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-sm">refresh</span> Regenerer
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={`p-3 sm:p-4 lg:p-6 bg-transparent ${!hasConversationStarted ? "sm:hidden" : ""}`}>
            <div className="max-w-3xl mx-auto">
              <form
                className="bg-white dark:bg-[#122118] rounded-2xl p-2 shadow-xl border border-slate-200 dark:border-slate-700 focus-within:ring-2 focus-within:ring-primary/30 transition-all"
                onSubmit={handleSubmit}
              >
                {pendingComposerFiles.length > 0 ? (
                  <div className="px-2 pb-2 mb-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap gap-2">
                    {pendingComposerFiles.map((file) => {
                      const key = composerFileKey(file);
                      return (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-slate-200"
                          key={key}
                        >
                          <span className="material-symbols-outlined text-[13px] text-primary">description</span>
                          <span className="max-w-[180px] truncate">{file.name}</span>
                          <button
                            className={`inline-flex items-center justify-center rounded-full ${
                              isUploadingComposerFiles
                                ? "text-slate-600 cursor-not-allowed"
                                : "text-slate-400 hover:text-red-400"
                            }`}
                            disabled={isUploadingComposerFiles}
                            onClick={() => removePendingComposerFile(key)}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-[14px]">close</span>
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                {isUploadingComposerFiles ? (
                  <div className="px-2 pb-2 mb-2 border-b border-slate-200 dark:border-slate-800">
                    <div className="flex items-center gap-2 text-xs text-slate-300">
                      <span className="material-symbols-outlined animate-spin text-[15px] text-primary">autorenew</span>
                      Chargement du document en cours...
                    </div>
                  </div>
                ) : null}
                <div className="flex items-end gap-2">
                  <button
                    className={`p-2.5 transition-colors rounded-xl ${
                      isUploadingComposerFiles
                        ? "text-slate-600 cursor-not-allowed"
                        : "text-slate-400 hover:text-primary hover:bg-slate-50 dark:hover:bg-[#1e2e24]"
                    }`}
                    disabled={isUploadingComposerFiles}
                    onClick={() => composerFileInputRef.current?.click()}
                    type="button"
                  >
                    <span className="material-symbols-outlined">attach_file</span>
                  </button>
                  <input
                    accept=".pdf,.doc,.docx,.txt,.md"
                    className="hidden"
                    multiple
                    onChange={(event) => {
                      handleComposerFilesSelected(event.target.files);
                      event.currentTarget.value = "";
                    }}
                    ref={composerFileInputRef}
                    type="file"
                  />
                  <textarea
                    className="flex-1 bg-transparent border-0 p-2.5 text-white caret-white placeholder:text-slate-400 focus:ring-0 resize-none max-h-40 text-base"
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Analysez un contrat ou posez une question..."
                    rows={1}
                    value={input}
                  ></textarea>
                  <div className="ml-1 flex items-center gap-1">
                    <button
                      className={`p-2.5 transition-colors rounded-xl ${
                        isRecording
                          ? "text-red-400 bg-red-500/10 hover:bg-red-500/20"
                          : "text-slate-400 hover:text-primary hover:bg-slate-50 dark:hover:bg-[#1e2e24]"
                      } ${isTranscribing ? "opacity-60 cursor-not-allowed" : ""}`}
                      disabled={isTranscribing}
                      onClick={() => void handleVoiceCapture()}
                      title={isRecording ? "Arreter l'enregistrement" : "Dicter votre question"}
                      type="button"
                    >
                      <span className="material-symbols-outlined filled text-[24px]">
                        {isRecording ? "stop_circle" : "mic"}
                      </span>
                    </button>
                    {isSending ? (
                      <button
                        className="p-2.5 bg-slate-900 hover:bg-slate-700 text-white rounded-xl transition-all flex items-center justify-center"
                        onClick={handleCancel}
                        type="button"
                      >
                        <span className="material-symbols-outlined filled">stop</span>
                      </button>
                    ) : isUploadingComposerFiles ? (
                      <button
                        className="p-2.5 bg-[#142A1C] text-[#21C853] rounded-xl transition-all flex items-center justify-center opacity-70 cursor-not-allowed"
                        disabled
                        type="button"
                      >
                        <span className="material-symbols-outlined filled text-[#21C853] animate-spin">autorenew</span>
                      </button>
                    ) : (
                      <button
                        className="p-2.5 bg-[#142A1C] hover:bg-[#1f3d2b] text-[#21C853] rounded-xl transition-all flex items-center justify-center shadow-lg shadow-primary/20 disabled:opacity-50"
                        disabled={isUploadingComposerFiles || (input.trim().length === 0 && pendingComposerFiles.length === 0)}
                        type="submit"
                      >
                        <span className="material-symbols-outlined filled text-[#21C853]">send</span>
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="text-[10px] text-center text-slate-400 mt-4">
                Analyses basees sur la legislation senegalaise en vigueur. Consultez un expert pour les decisions critiques.
              </p>
              {uiMessage ? <p className="text-xs text-emerald-500 mt-2 text-center">{uiMessage}</p> : null}
              {globalError ? <p className="text-xs text-red-500 mt-2 text-center">{globalError}</p> : null}
            </div>
          </div>
        </main>

        <aside
          className={`${isMobileRightPanelOpen ? "fixed inset-y-0 right-0 z-40 flex w-[90vw] max-w-sm shadow-2xl" : "hidden"} ${
            isWorkspacePanelOpen ? "lg:static lg:z-auto lg:flex lg:w-[400px]" : "lg:hidden"
          } bg-white dark:bg-[#122118] flex-col shrink-0 overflow-hidden`}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Workspace</p>
            <button
              className="inline-flex items-center justify-center rounded-md border border-slate-300 dark:border-slate-700 p-1.5"
              onClick={handleCloseWorkspacePanel}
              type="button"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
          <div className="flex border-b border-slate-200 dark:border-slate-800">
            <button
              className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${
                rightPanelTab === "workspace"
                  ? "border-b-2 border-primary text-[#21C853] bg-[#142A1C]"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setRightPanelTab("workspace")}
              type="button"
            >
              Workspace
            </button>
            <button
              className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${
                rightPanelTab === "notes"
                  ? "border-b-2 border-primary text-[#21C853] bg-[#142A1C]"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setRightPanelTab("notes")}
              type="button"
            >
              Notes
            </button>
            <button
              className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${
                rightPanelTab === "files"
                  ? "border-b-2 border-primary text-[#21C853] bg-[#142A1C]"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setRightPanelTab("files")}
              type="button"
            >
              Fichiers
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-5 no-scrollbar">
            {rightPanelTab === "workspace" ? (
              <div className="space-y-6">
                <button
                  className="w-full border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center group hover:border-primary/50 transition-colors cursor-pointer bg-slate-50/30 dark:bg-[#0a120e]/20"
                  onClick={() => workspaceFileInputRef.current?.click()}
                  type="button"
                >
                  <div className="size-12 rounded-full bg-slate-100 dark:bg-[#1e2e24] flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                    <span className="material-symbols-outlined text-slate-400 group-hover:text-primary">upload_file</span>
                  </div>
                  <p className="text-sm font-semibold">Deposez vos documents ici</p>
                  <p className="text-[10px] text-slate-500 mt-1">PDF, DOCX, TXT jusqu&apos;a 20MB</p>
                </button>
                <input
                  accept=".pdf,.doc,.docx,.txt,.md"
                  className="hidden"
                  multiple
                  onChange={(event) => {
                    void addWorkspaceFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                  ref={workspaceFileInputRef}
                  type="file"
                />

                <div>
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm text-primary">history</span>
                    Questions de la discussion
                  </h3>
                  {workspaceQuestionTurns.length === 0 ? (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800">
                      <p className="text-[11px] text-slate-500">Aucune question pour le moment.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {workspaceQuestionTurns.map((turn, index) => {
                        const isSelected = workspaceActiveTurn?.id === turn.id;
                        const label = (turn.displayQuestion ?? turn.question).trim() || `Question ${index + 1}`;
                        return (
                          <button
                            className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                              isSelected
                                ? "border-primary/50 bg-primary/10"
                                : "border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-[#1e2e24] hover:border-primary/30"
                            }`}
                            key={turn.id}
                            onClick={() => setWorkspaceSelectedTurnId(turn.id)}
                            type="button"
                          >
                            <p className="text-[11px] font-semibold text-slate-200 line-clamp-2">{label}</p>
                            <p className="text-[10px] text-slate-500 mt-1">
                              {turn.status === "error"
                                ? "Erreur"
                                : turn.status === "streaming"
                                  ? "Generation en cours"
                                  : "Reponse generee"}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm text-primary">menu_book</span>
                    Sources synthetisees dans la reponse
                  </h3>
                  {workspaceActiveTurn ? (
                    <p className="text-[11px] text-slate-400 mb-3 line-clamp-2">
                      Question active: {(workspaceActiveTurn.displayQuestion ?? workspaceActiveTurn.question).trim()}
                    </p>
                  ) : null}
                  <div className="space-y-3">
                    {citationCards.length === 0 ? (
                      <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800">
                        <p className="text-xs text-slate-500">
                          Aucune source explicitement synthetisee dans cette reponse.
                        </p>
                      </div>
                    ) : (
                      citationCards.map((card) => {
                        const chunkId = card.chunkId ?? "";
                        const chunkRecord = chunkId ? chunkDetailsById[chunkId] : undefined;
                        const isExpanded = chunkId ? expandedChunkIds[chunkId] === true : false;
                        return (
                          <div
                            className="p-4 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800 group hover:border-primary/30 transition-all"
                            key={`${card.badge}-${card.meta}`}
                          >
                            <div className="flex justify-between items-start mb-2">
                              <span className="text-[10px] font-bold text-primary px-2 py-0.5 bg-primary/10 rounded">
                                {card.badge}
                              </span>
                              <button className="text-slate-500 hover:text-white" onClick={() => void handleCitationOpen(card)} type="button">
                                <span className="material-symbols-outlined text-sm">open_in_new</span>
                              </button>
                            </div>
                            <p className="text-xs text-slate-600 dark:text-slate-300 italic leading-relaxed">
                              "{card.excerpt}"
                            </p>
                            <p className="text-[10px] text-slate-500 mt-2">{card.meta}</p>
                            <p className="text-[10px] mt-1 text-slate-400">
                              Source synthetisee et citee dans la reponse.
                            </p>
                            {chunkId ? (
                              <div className="mt-3">
                                <button
                                  className="text-[11px] font-semibold text-primary hover:text-primary/80 inline-flex items-center gap-1"
                                  onClick={() => toggleChunkPreview(chunkId)}
                                  type="button"
                                >
                                  <span className="material-symbols-outlined text-sm">
                                    {isExpanded ? "expand_less" : "expand_more"}
                                  </span>
                                  Voir le chunk exact utilise
                                </button>
                                {isExpanded ? (
                                  <div className="mt-2 rounded-lg border border-primary/20 bg-[#0f1c15] p-3">
                                    {chunkRecord ? (
                                      <>
                                        <p className="text-[10px] text-slate-400 mb-2">
                                          Chunk: {chunkRecord.chunk_id}
                                        </p>
                                        <p className="text-[11px] text-slate-200 whitespace-pre-wrap leading-relaxed max-h-52 overflow-y-auto">
                                          {renderHighlightedChunk(
                                            chunkRecord.text,
                                            card.articleHint ?? card.excerpt
                                          )}
                                        </p>
                                      </>
                                    ) : (
                                      <p className="text-[11px] text-slate-400">Chargement du passage exact...</p>
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800">
                  <p className="text-[10px] text-slate-400 uppercase font-bold mb-2">Visualisation des sources</p>
                  {sourceBreakdown.length === 0 ? (
                    <p className="text-[11px] text-slate-500">Aucune source a repartir pour cette reponse.</p>
                  ) : (
                    <div className="space-y-2">
                      {sourceBreakdown.map((item) => (
                        <div key={item.label}>
                          <div className="flex items-center justify-between text-[11px] mb-1">
                            <span className="text-slate-200">{item.label}</span>
                            <span className="text-primary font-bold">
                              {item.percent}% ({item.count})
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-700 overflow-hidden">
                            <div className="h-full bg-primary" style={{ width: `${item.percent}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800">
                    <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Confiance</p>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold">{confidencePercent}%</span>
                      <div className="flex-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${confidencePercent}%` }}></div>
                      </div>
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800">
                    <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Sources</p>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold">{displayedSourceCount}</span>
                      <span className="text-[10px] text-slate-500">sources synthetisees</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {rightPanelTab === "notes" ? (
              <div className="space-y-3 pt-2">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-primary">edit_note</span>
                  Prise de notes rapide
                </h3>
                <div className="bg-slate-50 dark:bg-[#1e2e24] rounded-xl p-3 border border-slate-100 dark:border-slate-800">
                  <textarea
                    className="w-full bg-transparent border-0 p-0 text-sm text-slate-600 dark:text-slate-300 focus:ring-0 min-h-[220px] resize-none"
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Prenez des notes sur cette analyse..."
                    value={notes}
                  ></textarea>
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-700 mt-2">
                    <span className="text-[10px] text-slate-500">{notes.trim().length} caracteres</span>
                    <button className="text-[10px] font-bold text-primary uppercase" onClick={() => void persistWorkspaceSnapshot()} type="button">
                      Sauvegarder maintenant
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {rightPanelTab === "files" ? (
              <div className="space-y-4">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm text-primary">folder</span>
                  Fichiers du Workspace
                </h3>
                {allWorkspaceFiles.length === 0 ? (
                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800">
                    <p className="text-xs text-slate-500">Aucun fichier pour le moment. Ajoutez un document depuis le chat.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {allWorkspaceFiles.map((file) => (
                      <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1e2e24] border border-slate-100 dark:border-slate-800" key={file.id}>
                        <p className="text-sm font-semibold break-all">{file.name}</p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          {formatFileSize(file.size)} - {formatDateLabel(file.addedAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#0a120e]/30">
            {rightPanelTab === "workspace" ? (
              <button className="w-full py-3 rounded-xl border border-primary/40 text-primary hover:bg-primary/10 transition-colors text-sm font-bold flex items-center justify-center gap-2" onClick={() => void persistWorkspaceSnapshot()} type="button">
                <span className="material-symbols-outlined text-sm">cloud_sync</span> Synchroniser le Workspace
              </button>
            ) : null}
            {rightPanelTab === "notes" ? (
              <button className="w-full py-3 rounded-xl border border-primary/40 text-primary hover:bg-primary/10 transition-colors text-sm font-bold flex items-center justify-center gap-2" onClick={() => setNotes("")} type="button">
                <span className="material-symbols-outlined text-sm">ink_eraser</span> Vider les notes
              </button>
            ) : null}
            {rightPanelTab === "files" ? (
              <button className="w-full py-3 rounded-xl border border-primary/40 text-primary hover:bg-primary/10 transition-colors text-sm font-bold flex items-center justify-center gap-2" onClick={() => void handleClearWorkspaceFiles()} type="button">
                <span className="material-symbols-outlined text-sm">delete</span> Nettoyer les fichiers locaux
              </button>
            ) : null}
          </div>
        </aside>

        {!isWorkspacePanelOpen ? (
          <button
            className="hidden lg:inline-flex fixed right-5 top-20 z-30 items-center gap-2 rounded-full border border-slate-700 bg-[#122118] px-4 py-2 text-xs font-semibold text-slate-200 shadow-xl hover:border-[#49DE80]/40 hover:text-[#49DE80] transition-colors"
            onClick={handleOpenWorkspacePanel}
            type="button"
          >
            <span className="material-symbols-outlined text-sm">workspaces</span>
            Workspace
          </button>
        ) : null}
      </div>

      {isActGeneratorOpen ? (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-6xl max-h-[92vh] overflow-hidden rounded-2xl border border-slate-700 bg-[#122118] shadow-2xl flex flex-col">
            <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-white">Generateur d'acte juridique</h3>
                <p className="text-sm text-slate-400 mt-1">
                  Assistant guide en 3 etapes: selection, formulaire, validation.
                </p>
              </div>
              <button
                className="p-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 transition-colors"
                onClick={closeActGenerator}
                type="button"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="px-5 pt-4">
              <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                <span>{isActValidating ? "Generation du document..." : "Progression"}</span>
                <span>{actMenuProgressPercent}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-[#0f1c15] overflow-hidden border border-slate-800">
                <div className="h-full bg-[#21C853] transition-all duration-300" style={{ width: `${actMenuProgressPercent}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-400">
                <div className={`rounded-md px-2 py-1 border ${actStep >= 1 ? "border-[#21C853]/40 text-[#21C853] bg-[#21C853]/10" : "border-slate-800"}`}>1. Type d'acte</div>
                <div className={`rounded-md px-2 py-1 border ${actStep >= 2 ? "border-[#21C853]/40 text-[#21C853] bg-[#21C853]/10" : "border-slate-800"}`}>2. Formulaire guide</div>
                <div className={`rounded-md px-2 py-1 border ${actStep >= 3 ? "border-[#21C853]/40 text-[#21C853] bg-[#21C853]/10" : "border-slate-800"}`}>3. Previsualisation</div>
              </div>
            </div>

            <div className="p-5 overflow-y-auto">
              {actStep === 1 ? (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-100">
                      Contexte complementaire (optionnel)
                    </label>
                    <textarea
                      className="w-full rounded-xl bg-[#0f1c15] border border-slate-700 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/40 min-h-[88px]"
                      onChange={(event) => setActUserIntent(event.target.value)}
                      placeholder="Ex: urgence, contraintes specifiques, objectif de negociation..."
                      value={actUserIntent}
                    ></textarea>
                  </div>

                  <div className="space-y-3">
                    <p className="text-sm font-semibold text-slate-100">Choisir le type d'acte</p>
                    <div className="space-y-4">
                      {actTemplatesByCategory.map((group) => (
                        <div className="space-y-2" key={group.category}>
                          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">
                            {group.category}
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                            {group.templates.map((template) => {
                              const isActive = template.type === actType;
                              return (
                                <button
                                  className={`text-left rounded-xl border p-3 transition-colors ${
                                    isActive
                                      ? "border-primary bg-primary/10 text-primary"
                                      : "border-slate-700 bg-[#0f1c15] text-slate-300 hover:border-primary/50"
                                  }`}
                                  key={template.type}
                                  onClick={() => handleActTypeChange(template.type)}
                                  type="button"
                                >
                                  <p className="font-semibold text-sm">{template.label}</p>
                                  <p className="text-[11px] mt-1 text-slate-400">{template.description}</p>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {actStep === 2 ? (
                <div className="space-y-5">
                  <div className="rounded-xl border border-slate-700 bg-[#0f1c15] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-100">{activeActTemplate.label}</p>
                        <p className="text-xs text-slate-400 mt-1">
                          Champs obligatoires remplis: {completedRequiredActFields} / {requiredActFields.length}
                        </p>
                      </div>
                      <span className="text-[11px] px-2 py-1 rounded-full bg-primary/15 text-primary font-semibold">
                        {activeActTemplate.branch}
                      </span>
                    </div>
                    <div className="mt-3 w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div className="h-full bg-[#21C853]" style={{ width: `${actProgressPercent}%` }} />
                    </div>
                  </div>

                  {actMissingItems.length > 0 ? (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                      <p className="text-sm font-semibold text-amber-300">Le modele signale des informations manquantes:</p>
                      <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-amber-100">
                        {actMissingItems.map((item) => (
                          <li key={`missing-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-slate-700 bg-[#0f1c15] p-4 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {activeActTemplate.fields.map((field) => {
                        const isMissingByModel = missingFieldLabelSet.has(normalizeForMatch(field.label));
                        const hasValue = (actValues[field.key] ?? "").trim().length > 0;
                        const fieldBorderClass = isMissingByModel
                          ? "border-amber-500/60"
                          : hasValue
                            ? "border-slate-700"
                            : "border-slate-800";
                        const fieldHint =
                          field.hint ||
                          field.placeholder ||
                          "Renseignez l'information la plus precise possible.";

                        return (
                          <div
                            className="rounded-xl border border-slate-800 bg-[#13221a] p-3"
                            key={`act-field-${field.key}`}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <p className="text-sm font-semibold text-slate-100">
                                {field.label}
                                {field.required ? <span className="text-red-400"> *</span> : null}
                              </p>
                              <span
                                className="material-symbols-outlined text-sm text-slate-400 cursor-help"
                                title={fieldHint}
                              >
                                help
                              </span>
                            </div>

                            {field.type === "textarea" ? (
                              <textarea
                                className={`w-full rounded-xl bg-[#102017] border ${fieldBorderClass} p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/40 min-h-[92px]`}
                                onChange={(event) => handleActFieldChange(field.key, event.target.value)}
                                placeholder={field.placeholder ?? ""}
                                value={actValues[field.key] ?? ""}
                              />
                            ) : null}

                            {field.type === "select" ? (
                              <select
                                className={`w-full rounded-xl bg-[#102017] border ${fieldBorderClass} p-3 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-primary/40`}
                                onChange={(event) => handleActFieldChange(field.key, event.target.value)}
                                value={actValues[field.key] ?? ""}
                              >
                                <option value="">Selectionner...</option>
                                {(field.options ?? []).map((option) => (
                                  <option key={`${field.key}-${option.value}`} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            ) : null}

                            {(!field.type ||
                              field.type === "text" ||
                              field.type === "date" ||
                              field.type === "number") ? (
                              <input
                                className={`w-full rounded-xl bg-[#102017] border ${fieldBorderClass} p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/40`}
                                onChange={(event) => handleActFieldChange(field.key, event.target.value)}
                                placeholder={field.placeholder ?? ""}
                                type={field.type ?? "text"}
                                value={actValues[field.key] ?? ""}
                              />
                            ) : null}

                            {isMissingByModel ? (
                              <p className="text-[11px] text-amber-300 mt-2">
                                A completer selon le dernier retour du modele.
                              </p>
                            ) : (
                              <p className="text-[11px] text-slate-500 mt-2">{fieldHint}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {actFieldError ? (
                      <p className="text-sm text-red-300">{actFieldError}</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {actStep === 3 ? (
                <div className="space-y-4">
                  {actValidationError ? (
                    <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
                      {actValidationError}
                    </div>
                  ) : null}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-slate-700 bg-[#0f1c15] p-4">
                      <h4 className="text-sm font-bold text-slate-100 mb-3">Resume des informations saisies</h4>
                      <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                        {activeActTemplate.fields.map((field) => {
                          const value = (actValues[field.key] ?? "").trim();
                          return (
                            <div className="rounded-lg bg-[#13221a] border border-slate-800 p-2.5" key={`summary-${field.key}`}>
                              <p className="text-[11px] text-slate-400">{field.label}</p>
                              <p className={`text-sm ${value ? "text-slate-100" : "text-amber-300"}`}>
                                {value || "[MANQUANT]"}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                      {actGeneratedDocument.trim().length > 0 ? (
                        <div className="mt-3 rounded-lg border border-[#21C853]/35 bg-[#21C853]/10 p-3">
                          <p className="text-[11px] text-[#7ff0a5] font-semibold uppercase tracking-wide">
                            Document final pret
                          </p>
                          <p className="text-xs text-slate-200 mt-1">
                            Cliquez sur &quot;Valider et exporter PDF&quot; pour telecharger la version finale.
                          </p>
                        </div>
                      ) : null}
                      <div className="mt-4 rounded-lg border border-slate-800 bg-[#0a120e] p-3">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                            Previsualisation du contrat
                          </p>
                          {actGeneratedDocument.trim().length > 0 ? (
                            <span className="text-[10px] text-[#7ff0a5]">modifiable via mini chat</span>
                          ) : null}
                        </div>
                        {actGeneratedDocument.trim().length > 0 ? (
                          <pre className="max-h-[300px] overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-slate-100">
                            {actGeneratedDocument}
                          </pre>
                        ) : (
                          <p className="text-xs text-slate-500">
                            Aucune version du contrat n&apos;est encore disponible.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-700 bg-[#0f1c15] p-4 flex flex-col">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <h4 className="text-sm font-bold text-slate-100">Mini chat de redaction</h4>
                        <span className="text-[11px] px-2 py-1 rounded-full bg-[#21C853]/15 text-[#21C853] font-semibold">
                          A droite
                        </span>
                      </div>

                      {actMissingItems.length > 0 ? (
                        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 mb-3">
                          <p className="text-sm font-semibold text-amber-300">Informations a completer:</p>
                          <ul className="mt-2 list-disc pl-5 space-y-1 text-sm text-amber-100">
                            {actMissingItems.map((item) => (
                              <li key={`preview-missing-${item}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      <div className="rounded-xl border border-slate-800 bg-[#0a120e] p-3 h-[300px] overflow-y-auto space-y-2">
                        {popupChatMessages.length === 0 ? (
                          <p className="text-xs text-slate-500">
                            Lancez une premiere demande pour que l&apos;assistant redige ou demande les informations manquantes.
                          </p>
                        ) : (
                          popupChatMessages.map((message) => (
                            <div
                              className={`max-w-[92%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                                message.role === "user"
                                  ? "ml-auto bg-[#21C853] text-black"
                                  : "mr-auto bg-[#13221a] text-slate-100 border border-slate-800"
                              }`}
                              key={message.id}
                            >
                              {message.content}
                            </div>
                          ))
                        )}
                      </div>

                      <form
                        className="mt-3 flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void handlePopupChatSubmit();
                        }}
                      >
                        <input
                          className="flex-1 rounded-xl bg-[#13221a] border border-slate-700 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary/40"
                          disabled={isPopupChatSending}
                          onChange={(event) => setPopupChatInput(event.target.value)}
                          placeholder="Ajoutez une precision (montant, date, parties, clause...)"
                          value={popupChatInput}
                        />
                        <button
                          className="px-4 py-2.5 rounded-xl bg-[#21C853] hover:bg-[#1db64a] text-[#0a120e] font-semibold transition-colors disabled:opacity-50"
                          disabled={isPopupChatSending || popupChatInput.trim().length === 0}
                          type="submit"
                        >
                          {isPopupChatSending ? "..." : "Envoyer"}
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="p-4 border-t border-slate-800 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500">
                Etape {actStep} / 3
              </div>
              <div className="flex items-center gap-2">
                {actStep === 1 ? (
                  <button
                    className="px-4 py-2 rounded-lg bg-[#21C853] hover:bg-[#1db64a] text-[#0a120e] font-semibold transition-colors"
                    onClick={handleActStepOneContinue}
                    type="button"
                  >
                    Continuer
                  </button>
                ) : null}

                {actStep === 2 ? (
                  <>
                    <button
                      className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 transition-colors"
                      onClick={handleActPrevious}
                      type="button"
                    >
                      Precedent
                    </button>
                    <button
                      className="px-4 py-2 rounded-lg bg-[#21C853] hover:bg-[#1db64a] text-[#0a120e] font-semibold transition-colors"
                      onClick={handleActNext}
                      type="button"
                    >
                      Validation
                    </button>
                  </>
                ) : null}

                {actStep === 3 ? (
                  <>
                    <button
                      className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 transition-colors"
                      onClick={() => setActStep(2)}
                      type="button"
                    >
                      ✏️ Modifier
                    </button>
                    <button
                      className="px-4 py-2 rounded-lg border border-[#21C853]/40 text-[#21C853] hover:bg-[#21C853]/10 transition-colors disabled:opacity-50"
                      disabled={actGeneratedDocument.trim().length === 0 || isActValidating}
                      onClick={exportPopupActDocument}
                      type="button"
                    >
                      {isActValidating ? "Analyse en cours..." : "Valider et exporter PDF"}
                    </button>
                  </>
                ) : null}

                <button
                  className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 transition-colors"
                  onClick={closeActGenerator}
                  type="button"
                >
                  Fermer
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
