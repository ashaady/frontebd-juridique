"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInButton, SignedIn, SignedOut, UserButton, useAuth, useUser } from "@clerk/nextjs";
import {
  buildLibraryViewUrl,
  deleteConsultationApi,
  listLibraryDocumentsApi,
  readConsultationsApi,
  readWorkspaceTemplatesApi,
  setWorkspaceUserContext,
  upsertWorkspaceTemplateApi,
  type LibraryDocumentRecord,
} from "../_lib/workspace-api";
import {
  type ConsultationRecord,
  type CustomDocumentTemplateRecord,
  type CustomTemplateFieldRecord,
  type TemplateComplexity,
} from "../_lib/workspace-store";
import { clerkUserButtonAppearance } from "../_lib/clerk-theme";

type LibraryViewProps = {
  title?: string;
};

type ViewMode = "list" | "grid";
type DocTypeFilter = "Tous" | string;

type DecoratedDocument = LibraryDocumentRecord & {
  icon: string;
  iconClass: string;
  categoryClass: string;
};

type DocumentTemplate = {
  id: string;
  name: string;
  category: string;
  domain: string;
  complexity: TemplateComplexity;
  description: string;
  legalRefs: string[];
  requiredFields: string[];
  optionalFields: string[];
  sections: string[];
  warning: string;
  isCustom?: boolean;
};

const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  {
    id: "contrat-bail",
    name: "Contrat de bail",
    category: "Contrats civils",
    domain: "Civil / Immobilier",
    complexity: "Simple",
    description: "Modele de bail d'habitation ou commercial avec clauses essentielles.",
    legalRefs: ["COCC", "Droit des obligations"],
    requiredFields: [
      "Nom du bailleur",
      "Nom du locataire",
      "Adresse du bien",
      "Usage du bien",
      "Duree du bail",
      "Montant du loyer",
      "Depot de garantie",
      "Date de prise d'effet",
      "Ville",
    ],
    optionalFields: ["Charges", "Penalites de retard", "Clause de revision du loyer"],
    sections: [
      "Titre",
      "Identification des parties",
      "Objet",
      "Duree",
      "Loyer et modalites de paiement",
      "Obligations des parties",
      "Resiliation",
      "Date, lieu et signatures",
    ],
    warning:
      "Verifier la conformite du bail avec la reglementation locale applicable avant signature.",
  },
  {
    id: "contrat-travail",
    name: "Contrat de travail",
    category: "Contrats de travail",
    domain: "Travail",
    complexity: "Intermediaire",
    description: "Modele de contrat adapte au Code du travail senegalais (CDI/CDD).",
    legalRefs: ["Code du travail senegalais", "Conventions collectives"],
    requiredFields: [
      "Employeur",
      "Salarie",
      "Poste",
      "Type de contrat",
      "Date de debut",
      "Remuneration",
      "Lieu de travail",
      "Duree hebdomadaire",
    ],
    optionalFields: ["Periode d'essai", "Prime", "Clause de confidentialite"],
    sections: [
      "Titre",
      "Parties",
      "Fonctions",
      "Remuneration",
      "Temps de travail",
      "Obligations",
      "Fin du contrat",
      "Signatures",
    ],
    warning:
      "Controler les dispositions obligatoires (duree legale, conges, preavis, protection sociale).",
  },
  {
    id: "mise-en-demeure",
    name: "Mise en demeure",
    category: "Contentieux et precontentieux",
    domain: "Civil / Commercial",
    complexity: "Simple",
    description: "Modele de lettre de sommation avant action judiciaire.",
    legalRefs: ["COCC", "Procedure civile"],
    requiredFields: [
      "Expediteur",
      "Destinataire",
      "Objet du litige",
      "Exposes des faits",
      "Delai accorde",
      "Date et ville",
    ],
    optionalFields: ["Montant reclame", "Interets", "Pieces jointes"],
    sections: [
      "Objet",
      "Rappel des faits",
      "Fondement juridique",
      "Sommes/obligations dues",
      "Delai d'execution",
      "Formule finale",
    ],
    warning:
      "Prevoir une preuve de notification (LRAR, huissier, remise contre decharge).",
  },
  {
    id: "plainte-penale",
    name: "Plainte penale",
    category: "Procedure penale",
    domain: "Penal",
    complexity: "Intermediaire",
    description: "Plainte structuree selon les regles de procedure penale senegalaise.",
    legalRefs: ["Code penal senegalais", "Code de procedure penale"],
    requiredFields: [
      "Plaignant",
      "Faits precis",
      "Date et lieu des faits",
      "Prejudice subi",
      "Autorite destinataire",
    ],
    optionalFields: ["Identite de l'auteur presume", "Temoins", "Pieces et preuves"],
    sections: [
      "Objet de la plainte",
      "Exposes circonstancies",
      "Qualification juridique",
      "Demandes",
      "Liste des preuves",
      "Signature",
    ],
    warning:
      "Ne pas avancer de qualifications non etablies sans verifier les faits et les textes.",
  },
  {
    id: "requete",
    name: "Requete",
    category: "Procedure civile",
    domain: "Procedure",
    complexity: "Intermediaire",
    description: "Requete adressee a une juridiction/autorite avec demandes precises.",
    legalRefs: ["Procedure civile", "Textes speciaux selon la matiere"],
    requiredFields: [
      "Requerant",
      "Juridiction/autorite",
      "Objet de la requete",
      "Faits",
      "Demandes",
      "Date et lieu",
    ],
    optionalFields: ["Base legale detaillee", "Pieces jointes", "Mesures urgentes sollicitees"],
    sections: [
      "En-tete",
      "Parties",
      "Faits",
      "Moyens de droit",
      "Demandes",
      "Formule de respect",
      "Signature",
    ],
    warning:
      "Verifier la competence de la juridiction et les delais proceduraux.",
  },
  {
    id: "assignation",
    name: "Assignation",
    category: "Procedure civile",
    domain: "Procedure civile / Commercial",
    complexity: "Avance",
    description: "Projet d'assignation introductive d'instance avec demandes chiffrees.",
    legalRefs: ["Procedure civile", "Actes uniformes OHADA selon le cas"],
    requiredFields: [
      "Demandeur",
      "Defendeur",
      "Juridiction competente",
      "Faits",
      "Demandes principal/es",
      "Base legale",
      "Date et lieu",
    ],
    optionalFields: ["Demandes subsidiaires", "Astreinte", "Execution provisoire"],
    sections: [
      "Identification des parties",
      "Exposes des faits",
      "Fondements juridiques",
      "Demandes",
      "Pieces communiquees",
      "Formules finales",
      "Signatures",
    ],
    warning:
      "Faire valider la strategie contentieuse et la competence territoriale avant signification.",
  },
  {
    id: "procuration",
    name: "Procuration",
    category: "Mandats et representations",
    domain: "Civil / Representation",
    complexity: "Simple",
    description: "Modele de mandat pour accomplir des actes au nom du mandant.",
    legalRefs: ["COCC", "Regles de representation"],
    requiredFields: [
      "Mandant",
      "Mandataire",
      "Objet/pouvoirs conferes",
      "Date de debut",
      "Date et lieu de signature",
    ],
    optionalFields: ["Date de fin", "Restrictions de pouvoirs", "Pieces d'identite"],
    sections: [
      "Titre",
      "Identite du mandant",
      "Identite du mandataire",
      "Etendue des pouvoirs",
      "Duree",
      "Signature et legalisation",
    ],
    warning:
      "Verifier si une legalisation/notarisation est exigee pour l'acte vise.",
  },
  {
    id: "statuts-ohada",
    name: "Statuts de societe (OHADA)",
    category: "Societes et OHADA",
    domain: "OHADA / Societes",
    complexity: "Avance",
    description: "Projet de statuts pour SARL/SA conforme au droit des societes OHADA.",
    legalRefs: ["Acte uniforme OHADA - droit des societes commerciales"],
    requiredFields: [
      "Denomination sociale",
      "Forme sociale",
      "Siege social",
      "Objet social",
      "Capital social",
      "Repartition des parts/actions",
      "Organe de direction",
      "Duree de la societe",
    ],
    optionalFields: ["Clauses d'agrement", "Clause d'inalienabilite", "Commissariat aux comptes"],
    sections: [
      "Forme et denomination",
      "Objet et siege",
      "Capital et titres",
      "Administration/gerance",
      "Assemblees",
      "Affectation des resultats",
      "Dissolution/liquidation",
      "Signatures des associes",
    ],
    warning:
      "Verification indispensable par un praticien OHADA avant depot et immatriculation.",
  },
  {
    id: "reconnaissance-dette",
    name: "Reconnaissance de dette",
    category: "Contrats civils",
    domain: "Civil / Obligations",
    complexity: "Simple",
    description: "Acte constatant une dette et ses modalites de remboursement.",
    legalRefs: ["COCC", "Droit des obligations"],
    requiredFields: [
      "Creancier",
      "Debiteur",
      "Montant de la dette",
      "Cause de la dette",
      "Date d'exigibilite",
      "Modalites de remboursement",
      "Date et lieu",
    ],
    optionalFields: ["Interets", "Garanties", "Clause de decheance du terme"],
    sections: [
      "Identite des parties",
      "Reconnaissance expresse de dette",
      "Montant et echeance",
      "Modalites de paiement",
      "Garanties",
      "Date, lieu et signatures",
    ],
    warning:
      "Prevoir une preuve de remise des fonds et la capacite juridique des signataires.",
  },
];

type GeneratedTemplateField = {
  key?: string;
  label?: string;
  required?: boolean;
  placeholder?: string;
  type?: "text" | "textarea" | "date" | "number" | "select";
  options?: Array<{ value?: string; label?: string }>;
  hint?: string;
};

type GeneratedTemplatePayload = {
  name?: string;
  category?: string;
  domain?: string;
  branch?: string;
  complexity?: TemplateComplexity | string;
  description?: string;
  legalRefs?: string[];
  requiredFields?: string[];
  optionalFields?: string[];
  sections?: string[];
  warning?: string;
  fields?: GeneratedTemplateField[];
};

function slugifyTemplateId(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "modele-personnalise";
}

function normalizeGeneratedComplexity(value: unknown): TemplateComplexity {
  const lowered = String(value ?? "").trim().toLowerCase();
  if (lowered === "avance") {
    return "Avance";
  }
  if (lowered === "intermediaire") {
    return "Intermediaire";
  }
  return "Simple";
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

function extractAssistantTextFromPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const data = payload as Record<string, unknown>;
  const direct = String(data.answer ?? "").trim();
  if (direct.length > 0) {
    return direct;
  }
  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const first = data.choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    const content = String(message?.content ?? first.text ?? "").trim();
    if (content.length > 0) {
      return content;
    }
  }
  return "";
}

function parseGeneratedTemplatePayload(candidate: string): GeneratedTemplatePayload | null {
  const raw = String(candidate ?? "").trim();
  if (!raw) {
    return null;
  }
  const attempts: string[] = [raw];

  const normalizedQuotes = raw
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ ]/g, " ");
  if (!attempts.includes(normalizedQuotes)) {
    attempts.push(normalizedQuotes);
  }

  const trailingCommaFixed = normalizedQuotes.replace(/,\s*([}\]])/g, "$1");
  if (!attempts.includes(trailingCommaFixed)) {
    attempts.push(trailingCommaFixed);
  }

  const singleQuoteFixed = trailingCommaFixed
    .replace(/([{,]\s*)'([^']+?)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*?)'(\s*[,}])/g, (_m, value, suffix) => {
      const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `: "${escaped}"${suffix}`;
    });
  if (!attempts.includes(singleQuoteFixed)) {
    attempts.push(singleQuoteFixed);
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as GeneratedTemplatePayload;
    } catch {
      // continue next repair attempt
    }
  }
  return null;
}

function normalizeFieldKey(name: string): string {
  return slugifyTemplateId(name).replace(/-/g, "_");
}

function toDocumentTemplateFromCustom(template: CustomDocumentTemplateRecord): DocumentTemplate {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    domain: template.domain,
    complexity: template.complexity,
    description: template.description,
    legalRefs: template.legalRefs,
    requiredFields: template.requiredFields,
    optionalFields: template.optionalFields,
    sections: template.sections,
    warning: template.warning,
    isCustom: true,
  };
}

function normalizeForMatch(raw: string): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toCustomTemplateFromGenerated(
  payload: GeneratedTemplatePayload,
  prompt: string
): CustomDocumentTemplateRecord {
  const nowIso = new Date().toISOString();
  const name = String(payload.name ?? "").trim() || "Modele juridique personnalise";
  const id = `custom-${slugifyTemplateId(name)}-${Date.now()}`;
  const rawFields = Array.isArray(payload.fields) ? payload.fields : [];
  const fields: CustomTemplateFieldRecord[] = rawFields
    .map((field, index): CustomTemplateFieldRecord | null => {
      const label = String(field.label ?? "").trim();
      if (!label) {
        return null;
      }
      const rawType = String(field.type ?? "text").trim().toLowerCase();
      const type: CustomTemplateFieldRecord["type"] =
        rawType === "textarea" || rawType === "date" || rawType === "number" || rawType === "select"
          ? (rawType as CustomTemplateFieldRecord["type"])
          : "text";
      const options = Array.isArray(field.options)
        ? field.options
            .map((option) => {
              const optionValue = String(option.value ?? "").trim();
              const optionLabel = String(option.label ?? "").trim() || optionValue;
              if (!optionValue) {
                return null;
              }
              return { value: optionValue, label: optionLabel };
            })
            .filter((option): option is { value: string; label: string } => Boolean(option))
        : [];
      return {
        key: String(field.key ?? "").trim() || normalizeFieldKey(`${label}-${index + 1}`),
        label,
        required: Boolean(field.required),
        placeholder: String(field.placeholder ?? "").trim() || undefined,
        type,
        options: type === "select" && options.length > 0 ? options : undefined,
        hint: String(field.hint ?? "").trim() || undefined,
      };
    })
    .filter((field): field is CustomTemplateFieldRecord => field !== null);

  const requiredFields = Array.from(
    new Set(
      (Array.isArray(payload.requiredFields) ? payload.requiredFields : [])
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    )
  );
  const optionalFields = Array.from(
    new Set(
      (Array.isArray(payload.optionalFields) ? payload.optionalFields : [])
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
    )
  );
  if (fields.length > 0 && requiredFields.length === 0) {
    for (const field of fields) {
      if (field.required) {
        requiredFields.push(field.label);
      }
    }
  }
  if (fields.length === 0 && requiredFields.length > 0) {
    for (const label of requiredFields) {
      fields.push({
        key: normalizeFieldKey(label),
        label,
        required: true,
        type: "text",
      });
    }
  }

  return {
    id,
    name,
    category: String(payload.category ?? "").trim() || "Modeles personnalises",
    domain: String(payload.domain ?? "").trim() || "Personnalise",
    branch: String(payload.branch ?? "").trim() || String(payload.domain ?? "").trim() || "Document juridique",
    complexity: normalizeGeneratedComplexity(payload.complexity),
    description: String(payload.description ?? "").trim() || `Modele genere depuis la demande: "${prompt}"`,
    legalRefs: (Array.isArray(payload.legalRefs) ? payload.legalRefs : [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0),
    requiredFields,
    optionalFields,
    sections: (Array.isArray(payload.sections) ? payload.sections : [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0),
    warning:
      String(payload.warning ?? "").trim() ||
      "Verifier la conformite du modele avec le droit senegalais avant utilisation.",
    fields,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function normalizePromptForDetection(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function toRequestedTemplateName(prompt: string): string {
  const raw = String(prompt ?? "").trim();
  if (!raw) {
    return "Modele personnalise";
  }
  const quotedMatch = raw.match(/["“«](.+?)["”»]/);
  let candidate = (quotedMatch?.[1] ?? raw).trim();
  candidate = candidate.replace(/\s+/g, " ");
  candidate = candidate.replace(
    /^(?:stp\s+|svp\s+)?(?:cree|cr[eé]e|genere|g[eé]n[eé]re|fais|fabrique)\s+(?:moi\s+)?|^(?:donne(?:-|\s)?moi|je\s+veux|j['’]ai\s+besoin\s+de)\s+/i,
    ""
  );
  candidate = candidate.replace(
    /^(?:un|une|le|la|les|des)\s+(?:modele|mod[eè]le|template)\s+(?:de|d['’])\s*/i,
    ""
  );
  candidate = candidate.replace(
    /^(?:un|une|le|la|les|des)\s+/i,
    ""
  );
  candidate = candidate.replace(/[.:;,\-–—\s]+$/g, "").trim();
  if (!candidate) {
    return "Modele personnalise";
  }
  const normalized =
    candidate.charAt(0).toUpperCase() + candidate.slice(1);
  return normalized.slice(0, 96);
}

function buildFallbackTemplateFromPrompt(prompt: string): CustomDocumentTemplateRecord {
  const lowered = normalizePromptForDetection(prompt);

  const commonWarning =
    "Verifier la conformite du modele avec le droit senegalais avant signature et usage.";

  const notarialTemplate: GeneratedTemplatePayload = {
    name: "Acte notarie",
    category: "Notariat",
    domain: "Droit civil / Notariat",
    branch: "Notariat",
    complexity: "Intermediaire",
    description: "Modele d'acte notarie personnalise pour formaliser une convention entre parties.",
    legalRefs: ["Code des obligations civiles et commerciales", "Reglementation notariale"],
    requiredFields: [
      "Nom complet partie 1",
      "Nom complet partie 2",
      "Objet de l'acte",
      "Montant ou valeur",
      "Date de signature",
      "Ville",
      "Office notarial",
    ],
    optionalFields: ["Temoins", "Garanties", "Clauses particulieres"],
    sections: [
      "Titre de l'acte",
      "Identification des parties",
      "Declarations et objet",
      "Clauses principales",
      "Dispositions notariales",
      "Date, lieu et signatures",
    ],
    warning: commonWarning,
    fields: [
      { key: "partie1_nom", label: "Nom complet partie 1", required: true, type: "text" },
      { key: "partie2_nom", label: "Nom complet partie 2", required: true, type: "text" },
      { key: "objet_acte", label: "Objet de l'acte", required: true, type: "textarea" },
      { key: "montant_valeur", label: "Montant ou valeur", required: true, type: "text" },
      { key: "date_signature", label: "Date de signature", required: true, type: "date" },
      { key: "ville", label: "Ville", required: true, type: "text" },
      { key: "office_notaire", label: "Office notarial", required: true, type: "text" },
      { key: "clauses_particulieres", label: "Clauses particulieres", required: false, type: "textarea" },
    ],
  };

  const contractTemplate: GeneratedTemplatePayload = {
    name: "Contrat personnalise",
    category: "Contrats civils",
    domain: "Droit des obligations",
    branch: "Contrat",
    complexity: "Simple",
    description: "Modele de contrat personnalise genere a partir de votre demande.",
    legalRefs: ["Code des obligations civiles et commerciales"],
    requiredFields: [
      "Nom partie 1",
      "Nom partie 2",
      "Objet du contrat",
      "Duree",
      "Montant",
      "Date de prise d'effet",
    ],
    optionalFields: ["Modalites de paiement", "Penalites", "Clause de resiliation"],
    sections: [
      "Titre",
      "Parties",
      "Objet",
      "Clauses essentielles",
      "Date, lieu et signatures",
    ],
    warning: commonWarning,
    fields: [
      { key: "partie1_nom", label: "Nom partie 1", required: true, type: "text" },
      { key: "partie2_nom", label: "Nom partie 2", required: true, type: "text" },
      { key: "objet_contrat", label: "Objet du contrat", required: true, type: "textarea" },
      { key: "duree", label: "Duree", required: true, type: "text" },
      { key: "montant", label: "Montant", required: true, type: "text" },
      { key: "date_effet", label: "Date de prise d'effet", required: true, type: "date" },
      { key: "modalites_paiement", label: "Modalites de paiement", required: false, type: "textarea" },
    ],
  };

  const genericTemplate: GeneratedTemplatePayload = {
    name: "Document juridique personnalise",
    category: "Modeles personnalises",
    domain: "Personnalise",
    branch: "Document juridique",
    complexity: "Simple",
    description: "Modele de document juridique genere automatiquement.",
    legalRefs: ["Droit senegalais applicable"],
    requiredFields: ["Parties concernees", "Objet", "Date", "Ville"],
    optionalFields: ["Contexte", "Pieces justificatives", "Clauses particulieres"],
    sections: ["Titre", "Contexte", "Corps du document", "Date, lieu et signatures"],
    warning: commonWarning,
    fields: [
      { key: "parties", label: "Parties concernees", required: true, type: "text" },
      { key: "objet", label: "Objet du document", required: true, type: "textarea" },
      { key: "date_document", label: "Date", required: true, type: "date" },
      { key: "ville", label: "Ville", required: true, type: "text" },
      { key: "clauses", label: "Clauses particulieres", required: false, type: "textarea" },
    ],
  };

  if (lowered.includes("notarie") || lowered.includes("notarial") || lowered.includes("notaire")) {
    return toCustomTemplateFromGenerated(notarialTemplate, prompt);
  }
  if (lowered.includes("contrat") || lowered.includes("bail") || lowered.includes("travail")) {
    return toCustomTemplateFromGenerated(contractTemplate, prompt);
  }
  return toCustomTemplateFromGenerated(genericTemplate, prompt);
}

function ensureTemplateReadiness(
  template: CustomDocumentTemplateRecord
): CustomDocumentTemplateRecord {
  const next: CustomDocumentTemplateRecord = {
    ...template,
    warning:
      String(template.warning ?? "").trim() ||
      "Verifier la conformite du modele avec le droit senegalais avant signature et usage.",
  };

  const fieldByKey = new Map<string, CustomTemplateFieldRecord>();
  for (const field of next.fields) {
    const key = String(field.key ?? "").trim();
    const label = String(field.label ?? "").trim();
    if (!key || !label) {
      continue;
    }
    fieldByKey.set(key, {
      ...field,
      key,
      label,
      type: field.type ?? "text",
      required: Boolean(field.required),
    });
  }

  const requiredSet = new Set(
    (next.requiredFields ?? []).map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
  );
  const optionalSet = new Set(
    (next.optionalFields ?? []).map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
  );

  const coreRequired: Array<{ key: string; label: string }> = [
    { key: "parties", label: "Parties concernees" },
    { key: "objet", label: "Objet du document" },
    { key: "date_document", label: "Date du document" },
    { key: "ville", label: "Ville" },
  ];

  for (const item of coreRequired) {
    if (!Array.from(fieldByKey.values()).some((field) => field.label.toLowerCase() === item.label.toLowerCase())) {
      fieldByKey.set(item.key, {
        key: item.key,
        label: item.label,
        required: true,
        type: item.key === "objet" ? "textarea" : item.key === "date_document" ? "date" : "text",
      });
    }
    requiredSet.add(item.label);
    optionalSet.delete(item.label);
  }

  for (const field of fieldByKey.values()) {
    if (field.required) {
      requiredSet.add(field.label);
      optionalSet.delete(field.label);
    }
  }

  next.fields = Array.from(fieldByKey.values());
  next.requiredFields = Array.from(requiredSet);
  next.optionalFields = Array.from(optionalSet).filter((label) => !requiredSet.has(label));
  if (!Array.isArray(next.sections) || next.sections.length === 0) {
    next.sections = [
      "Titre",
      "Identification des parties",
      "Objet",
      "Clauses principales",
      "Date, lieu et signatures",
    ];
  }
  return next;
}

function formatShortDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateConsultationTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Discussion";
  }
  if (normalized.length <= 96) {
    return normalized;
  }
  return `${normalized.slice(0, 93).trimEnd()}...`;
}

function consultationTitleLabel(record: ConsultationRecord): string {
  const direct = String(record.question ?? "").trim();
  if (direct && !/^session du/i.test(direct)) {
    return truncateConsultationTitle(direct);
  }
  const answerRaw = String(record.answer ?? "").trim();
  if (answerRaw.startsWith("{")) {
    try {
      const payload = JSON.parse(answerRaw) as Record<string, unknown>;
      const title = String(payload.title ?? "").trim();
      if (title) {
        return truncateConsultationTitle(title);
      }
    } catch {
      // Ignore malformed payload fallback below.
    }
  }
  if (direct) {
    return truncateConsultationTitle(direct.replace(/^session du/i, "Discussion"));
  }
  return "Discussion";
}

function iconForCategory(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized.includes("travail")) {
    return "badge";
  }
  if (normalized.includes("penal")) {
    return "gavel";
  }
  if (normalized.includes("electoral")) {
    return "how_to_vote";
  }
  if (normalized.includes("ohada")) {
    return "store";
  }
  if (normalized.includes("notariat")) {
    return "domain";
  }
  if (normalized.includes("fiscal")) {
    return "account_balance";
  }
  if (normalized.includes("constitution")) {
    return "history_edu";
  }
  return "picture_as_pdf";
}

function iconClassForCategory(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized.includes("travail")) {
    return "bg-emerald-500/15 text-emerald-300";
  }
  if (normalized.includes("penal")) {
    return "bg-purple-500/15 text-purple-300";
  }
  if (normalized.includes("electoral")) {
    return "bg-cyan-500/15 text-cyan-300";
  }
  if (normalized.includes("ohada")) {
    return "bg-amber-500/15 text-amber-300";
  }
  if (normalized.includes("notariat")) {
    return "bg-orange-500/15 text-orange-300";
  }
  if (normalized.includes("fiscal")) {
    return "bg-sky-500/15 text-sky-300";
  }
  if (normalized.includes("constitution")) {
    return "bg-indigo-500/15 text-indigo-300";
  }
  return "bg-red-500/15 text-red-300";
}

function badgeClassForCategory(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized.includes("travail")) {
    return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
  }
  if (normalized.includes("penal")) {
    return "bg-purple-500/20 text-purple-300 border-purple-500/30";
  }
  if (normalized.includes("electoral")) {
    return "bg-cyan-500/20 text-cyan-300 border-cyan-500/30";
  }
  if (normalized.includes("ohada")) {
    return "bg-amber-500/20 text-amber-300 border-amber-500/30";
  }
  if (normalized.includes("notariat")) {
    return "bg-orange-500/20 text-orange-300 border-orange-500/30";
  }
  if (normalized.includes("fiscal")) {
    return "bg-sky-500/20 text-sky-300 border-sky-500/30";
  }
  if (normalized.includes("constitution")) {
    return "bg-indigo-500/20 text-indigo-300 border-indigo-500/30";
  }
  return "bg-blue-500/20 text-blue-300 border-blue-500/30";
}

function enrichDocuments(rows: LibraryDocumentRecord[]): DecoratedDocument[] {
  return rows.map((row) => ({
    ...row,
    icon: iconForCategory(row.category),
    iconClass: iconClassForCategory(row.category),
    categoryClass: badgeClassForCategory(row.category),
  }));
}

export function LibraryView({ title = "Bibliotheque Juridique" }: LibraryViewProps) {
  const { isLoaded: isAuthLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const signInModalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [consultations, setConsultations] = useState<ConsultationRecord[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; question: string } | null>(null);
  const [documents, setDocuments] = useState<DecoratedDocument[]>([]);
  const [allLibraryDocuments, setAllLibraryDocuments] = useState<LibraryDocumentRecord[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [documentError, setDocumentError] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [articleSearch, setArticleSearch] = useState("");
  const [keywordSearch, setKeywordSearch] = useState("");
  const [infractionSearch, setInfractionSearch] = useState("");
  const [jurisdictionSearch, setJurisdictionSearch] = useState("");
  const [selectedSearchCategory, setSelectedSearchCategory] = useState("all");
  const [selectedDocumentId, setSelectedDocumentId] = useState("all");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedDocType, setSelectedDocType] = useState<DocTypeFilter>("Tous");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [currentPage, setCurrentPage] = useState(1);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedModelDomain, setSelectedModelDomain] = useState<string>("Tous");
  const [selectedModelComplexity, setSelectedModelComplexity] = useState<string>("Tous");
  const [selectedTemplateCategory, setSelectedTemplateCategory] = useState<string>("Tous");
  const [favoriteModelIds, setFavoriteModelIds] = useState<string[]>([]);
  const [recentModelIds, setRecentModelIds] = useState<string[]>([]);
  const [customTemplates, setCustomTemplates] = useState<CustomDocumentTemplateRecord[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [newTemplatePrompt, setNewTemplatePrompt] = useState<string>("");
  const [isGeneratingTemplate, setIsGeneratingTemplate] = useState<boolean>(false);
  const [templateGenerationProgress, setTemplateGenerationProgress] = useState<number>(0);
  const [templateGenerationError, setTemplateGenerationError] = useState<string>("");
  const [templateGenerationNotice, setTemplateGenerationNotice] = useState<string>("");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileLeftPanelOpen, setIsMobileLeftPanelOpen] = useState(false);
  const [isMobileSearchPanelOpen, setIsMobileSearchPanelOpen] = useState(false);
  const [isMobileAiStudioOpen, setIsMobileAiStudioOpen] = useState(false);
  const templateProgressResetTimerRef = useRef<number | null>(null);
  const hasAppliedExpertisePresetRef = useRef(false);

  const isDocumentsPage = title.toLowerCase().includes("documents");
  const backendBaseUrl = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";
    return raw.replace(/\/+$/, "");
  }, []);

  useEffect(() => {
    if (isDocumentsPage) {
      return;
    }
    const applyUrlSearch = () => {
      const params = new URLSearchParams(window.location.search);
      const nextSearchTerm = (params.get("q") ?? "").trim();
      const nextArticleSearch = (params.get("article") ?? "").trim();
      const nextKeywordSearch = (params.get("keyword") ?? "").trim();
      const nextInfractionSearch = (params.get("infractionType") ?? "").trim();
      const nextJurisdictionSearch = (params.get("jurisdiction") ?? "").trim();
      const nextDocumentId = (params.get("documentId") ?? "").trim();
      const rawCategories = (params.get("category") ?? "").trim();
      const nextCategories = rawCategories
        ? rawCategories
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];

      setSearchTerm(nextSearchTerm);
      setArticleSearch(nextArticleSearch);
      setKeywordSearch(nextKeywordSearch);
      setInfractionSearch(nextInfractionSearch);
      setJurisdictionSearch(nextJurisdictionSearch);
      setSelectedSearchCategory(nextCategories[0] ?? "all");
      setSelectedDocumentId(nextDocumentId || "all");
      if (nextCategories.length > 0) {
        setSelectedCategories(nextCategories);
      }
      setCurrentPage(1);
    };

    applyUrlSearch();
    window.addEventListener("popstate", applyUrlSearch);
    return () => {
      window.removeEventListener("popstate", applyUrlSearch);
    };
  }, [isDocumentsPage]);

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

  const requireSignedIn = useCallback(() => {
    if (!isAuthLoaded) {
      return false;
    }
    if (isSignedIn) {
      return true;
    }
    signInModalTriggerRef.current?.click();
    return false;
  }, [isAuthLoaded, isSignedIn]);

  useEffect(() => {
    if (!isDocumentsPage && isMobileAiStudioOpen) {
      setIsMobileAiStudioOpen(false);
    }
  }, [isDocumentsPage, isMobileAiStudioOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const rawFavorites = window.localStorage.getItem("juridiquesn:model-favorites");
      if (rawFavorites) {
        const parsed = JSON.parse(rawFavorites);
        if (Array.isArray(parsed)) {
          setFavoriteModelIds(parsed.filter((item) => typeof item === "string"));
        }
      }
      const rawRecent = window.localStorage.getItem("juridiquesn:model-recent");
      if (rawRecent) {
        const parsed = JSON.parse(rawRecent);
        if (Array.isArray(parsed)) {
          setRecentModelIds(parsed.filter((item) => typeof item === "string"));
        }
      }
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("juridiquesn:model-favorites", JSON.stringify(favoriteModelIds));
  }, [favoriteModelIds]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("juridiquesn:model-recent", JSON.stringify(recentModelIds));
  }, [recentModelIds]);

  useEffect(() => {
    if (!isGeneratingTemplate) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setTemplateGenerationProgress((previous) => {
        if (previous >= 92) {
          return previous;
        }
        if (previous < 30) {
          return previous + 5;
        }
        if (previous < 65) {
          return previous + 3;
        }
        return previous + 1;
      });
    }, 280);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isGeneratingTemplate]);

  useEffect(() => {
    return () => {
      if (templateProgressResetTimerRef.current !== null) {
        window.clearTimeout(templateProgressResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }
    let active = true;
    const loadTemplates = async () => {
      const rows = await readWorkspaceTemplatesApi();
      if (active) {
        setCustomTemplates(rows);
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
    const refreshCustomTemplates = async () => {
      const rows = await readWorkspaceTemplatesApi();
      setCustomTemplates(rows);
    };
    const onFocus = () => {
      void refreshCustomTemplates();
    };
    const onStorage = () => {
      void refreshCustomTemplates();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }
    if (!isSignedIn) {
      setConsultations([]);
      return;
    }
    let active = true;
    const loadConsultations = async () => {
      const rows = await readConsultationsApi();
      if (active) {
        setConsultations(rows);
      }
    };
    void loadConsultations();
    return () => {
      active = false;
    };
  }, [isAuthLoaded, isSignedIn]);

  useEffect(() => {
    if (!isAuthLoaded || !isSignedIn) {
      return;
    }
    let active = true;
    const sync = async () => {
      const rows = await readConsultationsApi();
      if (active) {
        setConsultations(rows);
      }
    };
    const onFocus = () => void sync();
    const onStorage = () => void sync();
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [isAuthLoaded, isSignedIn]);

  useEffect(() => {
    if (isDocumentsPage) {
      setLoadingDocuments(false);
      setDocumentError("");
      return;
    }
    let active = true;
    const timeoutId = window.setTimeout(async () => {
      setLoadingDocuments(true);
      setDocumentError("");
      const rows = await listLibraryDocumentsApi({
        q: searchTerm,
        category: selectedSearchCategory === "all" ? "" : selectedSearchCategory,
        article: articleSearch,
        keyword: keywordSearch,
        infractionType: infractionSearch,
        jurisdiction: jurisdictionSearch,
        documentId: selectedDocumentId === "all" ? "" : selectedDocumentId,
      });
      if (!active) {
        return;
      }
      const enriched = enrichDocuments(rows);
      setDocuments(enriched);
      setLoadingDocuments(false);
      if (enriched.length === 0) {
        setDocumentError("Aucun resultat pour cette recherche dans les chunks juridiques.");
      }
    }, 260);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    articleSearch,
    infractionSearch,
    isDocumentsPage,
    jurisdictionSearch,
    keywordSearch,
    searchTerm,
    selectedSearchCategory,
    selectedDocumentId,
  ]);

  useEffect(() => {
    if (isDocumentsPage) {
      return;
    }
    let active = true;
    const loadCatalog = async () => {
      const rows = await listLibraryDocumentsApi();
      if (!active) {
        return;
      }
      setAllLibraryDocuments(rows);
    };
    void loadCatalog();
    return () => {
      active = false;
    };
  }, [isDocumentsPage]);

  const searchCategoryOptions = useMemo(() => {
    const unique = Array.from(new Set(allLibraryDocuments.map((doc) => doc.category).filter(Boolean)));
    return unique.sort((a, b) => a.localeCompare(b, "fr"));
  }, [allLibraryDocuments]);

  const scopedSearchDocuments = useMemo(() => {
    const scoped =
      selectedSearchCategory === "all"
        ? allLibraryDocuments
        : allLibraryDocuments.filter((doc) => doc.category === selectedSearchCategory);
    return [...scoped].sort((a, b) => a.title.localeCompare(b.title, "fr"));
  }, [allLibraryDocuments, selectedSearchCategory]);

  useEffect(() => {
    if (selectedSearchCategory === "all") {
      return;
    }
    if (searchCategoryOptions.length === 0) {
      return;
    }
    if (searchCategoryOptions.includes(selectedSearchCategory)) {
      return;
    }
    const normalizedWanted = normalizeForMatch(selectedSearchCategory);
    const fuzzyCategory =
      searchCategoryOptions.find((category) => normalizeForMatch(category) === normalizedWanted) ??
      searchCategoryOptions.find((category) => {
        const normalizedCategory = normalizeForMatch(category);
        return (
          normalizedCategory.includes(normalizedWanted) ||
          normalizedWanted.includes(normalizedCategory)
        );
      }) ??
      null;
    if (fuzzyCategory) {
      setSelectedSearchCategory(fuzzyCategory);
      return;
    }
    setSelectedSearchCategory("all");
  }, [searchCategoryOptions, selectedSearchCategory]);

  useEffect(() => {
    if (selectedDocumentId === "all") {
      return;
    }
    if (allLibraryDocuments.length === 0) {
      return;
    }
    if (allLibraryDocuments.some((doc) => doc.id === selectedDocumentId)) {
      return;
    }
    setSelectedDocumentId("all");
  }, [allLibraryDocuments, selectedDocumentId]);

  useEffect(() => {
    if (selectedSearchCategory === "all" || selectedDocumentId === "all") {
      return;
    }
    if (scopedSearchDocuments.some((doc) => doc.id === selectedDocumentId)) {
      return;
    }
    setSelectedDocumentId("all");
  }, [scopedSearchDocuments, selectedDocumentId, selectedSearchCategory]);

  useEffect(() => {
    if (hasAppliedExpertisePresetRef.current) {
      return;
    }
    if (allLibraryDocuments.length === 0) {
      return;
    }
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const rawCategory = (params.get("category") ?? "").trim();
    const rawTitle = (params.get("documentTitle") ?? "").trim();
    const rawDocumentId = (params.get("documentId") ?? "").trim();
    if (!rawCategory && !rawTitle && !rawDocumentId) {
      hasAppliedExpertisePresetRef.current = true;
      return;
    }

    const byId =
      selectedDocumentId !== "all"
        ? allLibraryDocuments.find((doc) => doc.id === selectedDocumentId) ?? null
        : rawDocumentId
          ? allLibraryDocuments.find((doc) => doc.id === rawDocumentId) ?? null
          : null;
    if (byId) {
      if (selectedSearchCategory !== byId.category) {
        setSelectedSearchCategory(byId.category);
      }
      if (selectedDocumentId !== byId.id) {
        setSelectedDocumentId(byId.id);
      }
      hasAppliedExpertisePresetRef.current = true;
      return;
    }

    const categoryFromUrl = rawCategory
      ? searchCategoryOptions.find((category) => category === rawCategory) ??
        searchCategoryOptions.find((category) => normalizeForMatch(category) === normalizeForMatch(rawCategory)) ??
        searchCategoryOptions.find((category) => {
          const normalizedCategory = normalizeForMatch(category);
          const wanted = normalizeForMatch(rawCategory);
          return normalizedCategory.includes(wanted) || wanted.includes(normalizedCategory);
        }) ??
        "all"
      : "all";
    if (categoryFromUrl !== "all" && selectedSearchCategory !== categoryFromUrl) {
      setSelectedSearchCategory(categoryFromUrl);
    }

    if (!rawTitle) {
      hasAppliedExpertisePresetRef.current = true;
      return;
    }
    const normalizedWanted = normalizeForMatch(rawTitle);
    if (!normalizedWanted) {
      hasAppliedExpertisePresetRef.current = true;
      return;
    }
    const scoped = categoryFromUrl === "all"
      ? allLibraryDocuments
      : allLibraryDocuments.filter((doc) => doc.category === categoryFromUrl);
    const source = scoped.length > 0 ? scoped : allLibraryDocuments;
    const exact = source.find((doc) => normalizeForMatch(doc.title) === normalizedWanted);
    const contains =
      exact ??
      source.find((doc) => {
        const candidate = normalizeForMatch(doc.title);
        return candidate.includes(normalizedWanted) || normalizedWanted.includes(candidate);
      }) ??
      null;
    if (!contains) {
      hasAppliedExpertisePresetRef.current = true;
      return;
    }
    setSelectedSearchCategory(contains.category);
    setSelectedDocumentId(contains.id);
    hasAppliedExpertisePresetRef.current = true;
  }, [allLibraryDocuments, searchCategoryOptions, selectedDocumentId, selectedSearchCategory]);

  const recentSidebar = useMemo(() => consultations.slice(0, 8), [consultations]);

  const categories = useMemo(() => {
    const unique = Array.from(new Set(documents.map((doc) => doc.category)));
    return unique.sort((a, b) => a.localeCompare(b, "fr"));
  }, [documents]);

  const docTypeOptions = useMemo(() => {
    const unique = Array.from(new Set(documents.map((doc) => doc.docType)));
    return ["Tous", ...unique] as DocTypeFilter[];
  }, [documents]);

  useEffect(() => {
    if (categories.length === 0) {
      return;
    }
    setSelectedCategories((previous) => {
      if (previous.length === 0) {
        return categories;
      }
      const stillValid = previous.filter((category) => categories.includes(category));
      if (stillValid.length === previous.length) {
        return previous;
      }
      if (stillValid.length === 0) {
        return categories;
      }
      return stillValid;
    });
  }, [categories]);

  const filteredDocuments = useMemo(() => {
    return documents.filter((doc) => {
      if (selectedCategories.length === 0) {
        return false;
      }
      if (!selectedCategories.includes(doc.category)) {
        return false;
      }
      if (selectedDocType !== "Tous" && doc.docType !== selectedDocType) {
        return false;
      }
      return true;
    });
  }, [documents, selectedCategories, selectedDocType]);

  const pageSize = viewMode === "list" ? 8 : 9;
  const totalPages = Math.max(1, Math.ceil(filteredDocuments.length / pageSize));
  const clampedPage = Math.min(currentPage, totalPages);
  const currentRows = filteredDocuments.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  const availableTemplates = useMemo(() => {
    const customAsDocumentTemplates = customTemplates.map((template) =>
      toDocumentTemplateFromCustom(template)
    );
    const byId = new Map<string, DocumentTemplate>();
    for (const template of [...DOCUMENT_TEMPLATES, ...customAsDocumentTemplates]) {
      byId.set(template.id, template);
    }
    return Array.from(byId.values());
  }, [customTemplates]);

  const modelDomains = useMemo(() => {
    const values = Array.from(new Set(availableTemplates.map((template) => template.domain)));
    return ["Tous", ...values.sort((a, b) => a.localeCompare(b, "fr"))];
  }, [availableTemplates]);

  const modelComplexities = useMemo(
    () => ["Tous", "Simple", "Intermediaire", "Avance"] as const,
    []
  );

  const filteredTemplates = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return availableTemplates.filter((template) => {
      if (selectedModelDomain !== "Tous" && template.domain !== selectedModelDomain) {
        return false;
      }
      if (selectedModelComplexity !== "Tous" && template.complexity !== selectedModelComplexity) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack =
        `${template.name} ${template.description} ${template.domain} ${template.category} ${template.legalRefs.join(" ")}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [availableTemplates, modelSearch, selectedModelDomain, selectedModelComplexity]);

  const groupedTemplates = useMemo(() => {
    const groups = new Map<string, DocumentTemplate[]>();
    for (const template of filteredTemplates) {
      const key = template.category || "Autres";
      const current = groups.get(key) ?? [];
      current.push(template);
      groups.set(key, current);
    }
    return Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right, "fr"))
      .map(([category, templates]) => ({
        category,
        templates: templates.sort((left, right) => left.name.localeCompare(right.name, "fr")),
      }));
  }, [filteredTemplates]);

  const compactTemplates = useMemo(
    () =>
      groupedTemplates.flatMap((group) =>
        group.templates.map((template) => ({
          ...template,
          _categoryOrder: group.category,
        }))
      ),
    [groupedTemplates]
  );

  const templateCategoryOptions = useMemo(() => {
    const unique = Array.from(new Set(compactTemplates.map((template) => template.category).filter(Boolean)));
    return ["Tous", ...unique.sort((a, b) => a.localeCompare(b, "fr"))];
  }, [compactTemplates]);

  useEffect(() => {
    if (templateCategoryOptions.includes(selectedTemplateCategory)) {
      return;
    }
    setSelectedTemplateCategory("Tous");
  }, [selectedTemplateCategory, templateCategoryOptions]);

  const displayedTemplates = useMemo(() => {
    if (selectedTemplateCategory === "Tous") {
      return compactTemplates;
    }
    return compactTemplates.filter((template) => template.category === selectedTemplateCategory);
  }, [compactTemplates, selectedTemplateCategory]);

  useEffect(() => {
    if (selectedModelId && availableTemplates.some((template) => template.id === selectedModelId)) {
      return;
    }
    setSelectedModelId(availableTemplates[0]?.id ?? "");
  }, [availableTemplates, selectedModelId]);

  const selectedTemplate = useMemo(() => {
    const byId = availableTemplates.find((item) => item.id === selectedModelId);
    if (byId) {
      return byId;
    }
    return filteredTemplates[0] ?? availableTemplates[0] ?? null;
  }, [availableTemplates, filteredTemplates, selectedModelId]);

  const recentTemplates = useMemo(() => {
    const byId = new Map(availableTemplates.map((item) => [item.id, item]));
    return recentModelIds.map((id) => byId.get(id)).filter((item): item is DocumentTemplate => Boolean(item));
  }, [availableTemplates, recentModelIds]);

  const openChatWithQuestion = (question: string) => {
    if (!requireSignedIn()) {
      return;
    }
    setIsMobileLeftPanelOpen(false);
    router.push(`/chat?q=${encodeURIComponent(question)}`);
  };

  const openActGeneratorFromDashboard = () => {
    if (!requireSignedIn()) {
      return;
    }
    setIsMobileLeftPanelOpen(false);
    router.push("/chat?act=1");
  };

  const requestDeleteConsultation = (consultationId: string, question: string) => {
    setPendingDelete({ id: consultationId, question });
  };

  const cancelDeleteConsultation = () => {
    setPendingDelete(null);
  };

  const confirmDeleteConsultation = async () => {
    if (!requireSignedIn()) {
      return;
    }
    if (!pendingDelete) {
      return;
    }
    const rows = await deleteConsultationApi(pendingDelete.id);
    setConsultations(rows);
    setPendingDelete(null);
  };

  const resetFilters = () => {
    setSearchTerm("");
    setSelectedCategories(categories);
    setSelectedDocType("Tous");
    setArticleSearch("");
    setKeywordSearch("");
    setInfractionSearch("");
    setJurisdictionSearch("");
    setSelectedSearchCategory("all");
    setSelectedDocumentId("all");
    setCurrentPage(1);
  };

  const clearAdvancedSearch = () => {
    setCurrentPage(1);
    setArticleSearch("");
    setKeywordSearch("");
    setInfractionSearch("");
    setJurisdictionSearch("");
    setSelectedSearchCategory("all");
    setSelectedDocumentId("all");
  };

  const applySearchCategory = (nextCategory: string) => {
    setCurrentPage(1);
    setSelectedSearchCategory(nextCategory);
    setSelectedDocumentId("all");
  };

  const advancedSearchCount = [
    articleSearch,
    keywordSearch,
    infractionSearch,
    jurisdictionSearch,
    selectedSearchCategory !== "all" ? "category-filter" : "",
    selectedDocumentId !== "all" ? "document-filter" : "",
  ].filter((value) => value.trim().length > 0).length;

  const handleAskAi = (doc: DecoratedDocument) => {
    if (!requireSignedIn()) {
      return;
    }
    const prompt = `Analyse ce document: ${doc.title}.`;
    openChatWithQuestion(prompt);
  };

  const handleDownload = (doc: DecoratedDocument) => {
    if (!requireSignedIn()) {
      return;
    }
    const url = buildLibraryViewUrl(doc.id);
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const markRecentTemplate = (templateId: string) => {
    setRecentModelIds((previous) => [templateId, ...previous.filter((id) => id !== templateId)].slice(0, 10));
  };

  const openTemplateInChat = (template: DocumentTemplate) => {
    if (!requireSignedIn()) {
      return;
    }
    markRecentTemplate(template.id);
    setIsMobileLeftPanelOpen(false);
    router.push(`/chat?act=1&new=1&template=${encodeURIComponent(template.id)}`);
  };

  const handleGenerateTemplateWithAi = useCallback(async () => {
    const prompt = newTemplatePrompt.trim();
    if (!prompt) {
      setTemplateGenerationError("Decrivez le modele a creer.");
      return;
    }
    if (!requireSignedIn()) {
      return;
    }
    if (isGeneratingTemplate) {
      return;
    }

    const requestedTemplateName = toRequestedTemplateName(prompt);

    const persistTemplate = async (
      template: CustomDocumentTemplateRecord,
      noticeMessage: string = ""
    ) => {
      const readyTemplate = ensureTemplateReadiness({
        ...template,
        name: requestedTemplateName,
      });
      setTemplateGenerationProgress((previous) => Math.max(previous, 88));
      setCustomTemplates((previous) => [
        readyTemplate,
        ...previous.filter((row) => row.id !== readyTemplate.id),
      ]);
      setSelectedModelId(readyTemplate.id);
      setRecentModelIds((previous) =>
        [readyTemplate.id, ...previous.filter((id) => id !== readyTemplate.id)].slice(0, 10)
      );
      setModelSearch("");
      setSelectedModelDomain("Tous");
      setSelectedModelComplexity("Tous");
      setCurrentPage(1);
      let persistedRemotely = true;
      try {
        const nextRows = await upsertWorkspaceTemplateApi(readyTemplate);
        setCustomTemplates(nextRows);
      } catch {
        persistedRemotely = false;
        const localOnlyMessage =
          "Modele cree localement. La synchronisation distante sera retentee automatiquement.";
        if (noticeMessage.trim().length > 0) {
          setTemplateGenerationNotice(`${noticeMessage} ${localOnlyMessage}`.trim());
        } else {
          setTemplateGenerationNotice(localOnlyMessage);
        }
      }
      setNewTemplatePrompt("");
      setTemplateGenerationError("");
      if (persistedRemotely && noticeMessage.trim().length > 0) {
        setTemplateGenerationNotice(noticeMessage);
      } else if (persistedRemotely) {
        setTemplateGenerationNotice(`Modele "${readyTemplate.name}" cree et selectionne.`);
      }
    };

    setTemplateGenerationError("");
    setTemplateGenerationNotice("");
    if (templateProgressResetTimerRef.current !== null) {
      window.clearTimeout(templateProgressResetTimerRef.current);
      templateProgressResetTimerRef.current = null;
    }
    setTemplateGenerationProgress(6);
    setIsGeneratingTemplate(true);
    try {
      const generationPrompt = [
        "Tu es juriste redacteur specialise en droit senegalais/OHADA.",
        "Tu t'appuies d'abord sur les sources juridiques recuperees par RAG.",
        "Genere un modele de document juridique SENEGALAIS et retourne UNIQUEMENT un JSON valide.",
        "Schema strict:",
        "{\"name\":\"...\",\"category\":\"...\",\"domain\":\"...\",\"branch\":\"...\",\"complexity\":\"Simple|Intermediaire|Avance\",\"description\":\"...\",\"legalRefs\":[\"...\"],\"requiredFields\":[\"...\"],\"optionalFields\":[\"...\"],\"sections\":[\"...\"],\"warning\":\"...\",\"fields\":[{\"key\":\"...\",\"label\":\"...\",\"required\":true,\"type\":\"text|textarea|date|number|select\",\"placeholder\":\"...\",\"hint\":\"...\",\"options\":[{\"value\":\"...\",\"label\":\"...\"}]}]}",
        "Contraintes:",
        "- Le JSON doit etre utilisable tel quel.",
        "- Au moins 6 champs obligatoires dans fields.",
        "- category doit etre une categorie claire (ex: Contrats civils, Procedure penale, Societes et OHADA).",
        "- requiredFields doit correspondre aux champs required=true.",
        "- Ajouter les references juridiques pertinentes dans legalRefs.",
        "- Les champs doivent couvrir les informations necessaires a la redaction pratique du document.",
        "- Ne retourne aucun texte hors JSON.",
        "",
        `Demande utilisateur: ${prompt}`,
      ].join("\n");
      setTemplateGenerationProgress((previous) => Math.max(previous, 20));

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 12000);

      let response: Response;
      try {
        response = await fetch(`${backendBaseUrl}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-Auth-Mode": isSignedIn ? "signed-in" : "guest",
            ...(userId ? { "X-User-Id": userId } : {}),
            ...(user?.primaryEmailAddress?.emailAddress
              ? { "X-User-Email": user.primaryEmailAddress.emailAddress }
              : {}),
            ...(user?.fullName || user?.firstName
              ? { "X-User-Name": user.fullName ?? user.firstName ?? "" }
              : {}),
            ...(user?.username ? { "X-User-Username": user.username } : {}),
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: generationPrompt }],
            temperature: 0,
            top_p: 0.8,
            max_tokens: 900,
            thinking: false,
            use_rag: true,
            rag_query_rewrite: true,
          }),
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeoutId);
      }
      setTemplateGenerationProgress((previous) => Math.max(previous, 62));

      const rawBody = await response.text();
      let parsedPayload: unknown = null;
      if (rawBody.trim().length > 0) {
        try {
          parsedPayload = JSON.parse(rawBody);
        } catch {
          parsedPayload = rawBody;
        }
      }
      setTemplateGenerationProgress((previous) => Math.max(previous, 72));

      if (!response.ok) {
        const fallbackTemplate = buildFallbackTemplateFromPrompt(prompt);
        await persistTemplate(
          fallbackTemplate,
          "Modele cree automatiquement et pret a etre utilise."
        );
        return;
      }

      const assistantText = extractAssistantTextFromPayload(parsedPayload);
      const jsonCandidate = extractJsonObjectFromText(assistantText);
      if (!jsonCandidate) {
        const fallbackTemplate = buildFallbackTemplateFromPrompt(prompt);
        await persistTemplate(
          fallbackTemplate,
          "Modele cree automatiquement et pret a etre utilise."
        );
        return;
      }

      const generated = parseGeneratedTemplatePayload(jsonCandidate);
      if (!generated) {
        const fallbackTemplate = buildFallbackTemplateFromPrompt(prompt);
        await persistTemplate(
          fallbackTemplate,
          "Modele cree automatiquement et pret a etre utilise."
        );
        return;
      }

      const customTemplate = ensureTemplateReadiness(toCustomTemplateFromGenerated(generated, prompt));
      if (customTemplate.fields.length === 0) {
        const fallbackTemplate = buildFallbackTemplateFromPrompt(prompt);
        await persistTemplate(
          fallbackTemplate,
          "Modele cree automatiquement et pret a etre utilise."
        );
        return;
      }

      await persistTemplate(customTemplate);
    } catch (error) {
      try {
        const fallbackTemplate = buildFallbackTemplateFromPrompt(prompt);
        await persistTemplate(
          fallbackTemplate,
          "Modele cree automatiquement et pret a etre utilise."
        );
      } catch {
        const detail =
          error instanceof Error ? error.message : "Generation du modele impossible pour le moment.";
        setTemplateGenerationError(detail);
      }
    } finally {
      setTemplateGenerationProgress(100);
      setIsGeneratingTemplate(false);
      templateProgressResetTimerRef.current = window.setTimeout(() => {
        setTemplateGenerationProgress((previous) => (previous >= 100 ? 0 : previous));
        templateProgressResetTimerRef.current = null;
      }, 900);
    }
  }, [backendBaseUrl, isGeneratingTemplate, newTemplatePrompt, requireSignedIn]);

  const aiStudioPanelContent = (
    <>
      <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="material-symbols-outlined text-[#49DE80] text-[18px]">auto_awesome</span>
            AI Legal Studio
          </h2>
          <span className="px-2 py-0.5 rounded-full bg-emerald-900 text-[#49DE80] text-[10px] font-bold border border-emerald-500/30">
            BETA
          </span>
        </div>

        <div className="space-y-3">
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Creer un modele par IA
          </label>
          <div className="relative group">
            <textarea
              className="w-full h-40 bg-[#0c1811] border border-[#2c3d33] rounded-xl p-4 text-sm text-slate-200 focus:ring-1 focus:ring-[#49DE80] focus:border-[#49DE80] resize-none transition-all placeholder-slate-600"
              onChange={(event) => setNewTemplatePrompt(event.target.value)}
              placeholder='Ex: "Cree un contrat de prestation de service informatique conforme au droit senegalais"'
              value={newTemplatePrompt}
            ></textarea>
            <div className="absolute bottom-3 right-3 flex gap-2">
              <button
                className="p-1.5 rounded-lg bg-[#122118] border border-[#2c3d33] text-slate-400 hover:text-white hover:border-[#49DE80] transition-all"
                title="Ajouter contexte"
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">attach_file</span>
              </button>
              <button
                className="p-1.5 rounded-lg bg-[#49DE80] text-[#0c1811] hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-60"
                disabled={isGeneratingTemplate}
                onClick={() => void handleGenerateTemplateWithAi()}
                title="Generer"
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isGeneratingTemplate ? "hourglass_top" : "send"}
                </span>
              </button>
            </div>
          </div>
          {templateGenerationError ? (
            <p className="text-xs text-rose-300">{templateGenerationError}</p>
          ) : null}
          {templateGenerationNotice ? (
            <p className="text-xs text-emerald-300">{templateGenerationNotice}</p>
          ) : null}
        </div>

        <div className="bg-[#0c1811] rounded-xl p-4 border border-[#2c3d33] space-y-3">
          <div className="flex justify-between items-center text-xs">
            <span className="font-semibold text-slate-300">Generating clauses...</span>
            <span className="text-[#49DE80] font-mono">
              {Math.max(0, Math.min(100, Math.round(templateGenerationProgress || (isGeneratingTemplate ? 72 : 0))))}%
            </span>
          </div>
          <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-[#49DE80] transition-all duration-300"
              style={{
                width: `${Math.max(2, Math.min(100, templateGenerationProgress || (isGeneratingTemplate ? 72 : 4)))}%`,
              }}
            />
          </div>
          <div className="text-[10px] text-slate-500 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[#49DE80] animate-pulse"></span>
            Cross-referencing OHADA articles...
          </div>
        </div>

        <div className="space-y-3 pt-4 border-t border-[#2c3d33]">
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px] text-amber-400">bolt</span>
            Quick Prompts
          </label>
          <div className="space-y-2">
            {(displayedTemplates.length > 0 ? displayedTemplates : compactTemplates).slice(0, 3).map((template) => (
              <button
                className="w-full text-left p-3 rounded-xl bg-[#122118] border border-[#2c3d33] hover:border-[#49DE80] hover:bg-[#254632]/20 transition-all group"
                key={`quick-right-rail-${template.id}`}
                onClick={() => setNewTemplatePrompt(`Draft a ${template.name} compliant with Senegalese law.`)}
                type="button"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="material-symbols-outlined text-[16px] text-slate-500 group-hover:text-[#49DE80]">gavel</span>
                  <span className="text-xs font-bold text-slate-300 group-hover:text-white">{template.name}</span>
                </div>
                <p className="text-[10px] text-slate-500 line-clamp-1 group-hover:text-slate-400">{template.description}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="p-4 bg-[#0c1811] border-t border-[#2c3d33] text-[10px] text-slate-600 text-center leading-tight">
        AI generated content is for reference only. Consult a qualified lawyer before signing.
      </div>
    </>
  );

  return (
    <div className="min-h-screen lg:h-screen flex flex-col overflow-x-hidden lg:overflow-hidden bg-[#112117] text-slate-100">
      <SignedOut>
        <SignInButton mode="modal">
          <button ref={signInModalTriggerRef} type="button" className="hidden" aria-hidden="true" />
        </SignInButton>
      </SignedOut>
      <header className="px-3 sm:px-6 py-3 bg-white dark:bg-[#122118] border-b border-slate-200 dark:border-slate-800 shrink-0 z-20">
        <div className="flex items-center gap-3 w-full min-w-0">
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
            }}
            type="button"
          >
            <span className="material-symbols-outlined text-base">menu</span>
          </button>
          <button
            className={`${isSidebarCollapsed ? "lg:w-16" : "lg:w-72"} flex items-center gap-2 shrink-0 min-w-0 text-left`}
            onClick={() => router.push("/chat?new=1")}
            type="button"
          >
            <div className="size-8 bg-[#13221a] border border-[#49DE80]/40 rounded flex items-center justify-center">
              <span className="material-symbols-outlined text-[#49DE80] font-bold">gavel</span>
            </div>
            <h1 className={`text-lg font-bold tracking-tight truncate ${isSidebarCollapsed ? "lg:hidden" : ""}`}>
              Juridique <span className="text-[#7ef1a9]">SN</span>
            </h1>
          </button>
          <div className="hidden md:flex items-center gap-4 min-w-0 flex-1">
            <span className="flex items-center gap-1 text-[10px] font-bold text-[#49DE80] uppercase tracking-wider shrink-0">
              <span className="size-2 bg-[#49DE80] rounded-full animate-pulse"></span>
              Actualites
            </span>
            <div className="news-ticker flex-1 overflow-hidden">
              <div className="news-ticker-track text-sm text-slate-400">
                <span className="news-ticker-item pr-16">
                  Bibliotheque connectee aux PDF reels du dossier droit donnees | Consultation des textes en continu...
                </span>
                <span aria-hidden="true" className="news-ticker-item pr-16">
                  Bibliotheque connectee aux PDF reels du dossier droit donnees | Consultation des textes en continu...
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
          <div className="lg:hidden flex items-center gap-2 ml-auto shrink-0">
            <SignedOut>
              <Link
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-[#1e2e24] transition-colors"
                href="/sign-in"
              >
                Connexion
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
        </div>
        <div className="md:hidden mt-2 flex items-center gap-2 min-w-0">
          <span className="flex items-center gap-1 text-[10px] font-bold text-[#49DE80] uppercase tracking-wider shrink-0">
            <span className="size-2 bg-[#49DE80] rounded-full animate-pulse"></span>
            Actu
          </span>
          <div className="news-ticker flex-1 overflow-hidden min-w-0">
            <div className="news-ticker-track text-xs text-slate-500 dark:text-slate-400">
              <span className="news-ticker-item pr-12">
                Bibliotheque connectee aux PDF reels du dossier droit donnees | Consultation des textes en continu...
              </span>
              <span aria-hidden="true" className="news-ticker-item pr-12">
                Bibliotheque connectee aux PDF reels du dossier droit donnees | Consultation des textes en continu...
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {isMobileLeftPanelOpen ? (
          <button
            aria-label="Fermer le menu"
            className="lg:hidden fixed inset-0 z-30 bg-black/45 backdrop-blur-[1px]"
            onClick={() => setIsMobileLeftPanelOpen(false)}
            type="button"
          />
        ) : null}

        <aside
          className={`${
            isMobileLeftPanelOpen ? "fixed inset-y-0 left-0 z-40 flex w-[84vw] max-w-xs shadow-2xl" : "hidden"
          } lg:static lg:z-auto lg:flex ${isSidebarCollapsed ? "lg:w-16" : "lg:w-72"} bg-[#0c1811] border-r border-slate-800 flex-col shrink-0 transition-all duration-300`}
        >
          <div className={isSidebarCollapsed ? "p-2" : "p-6"}>
            <div className={`flex ${isSidebarCollapsed ? "flex-col items-center gap-2" : "items-center justify-between"} mb-6`}>
              <button
                className={`flex items-center ${isSidebarCollapsed ? "" : "gap-3"} text-left`}
                onClick={() => {
                  setIsMobileLeftPanelOpen(false);
                  router.push("/chat?new=1");
                }}
                type="button"
              >
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
              </button>
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
              <Link
                className="flex w-full items-center gap-3 bg-[#49DE80] hover:bg-[#49DE80]/90 text-[#112117] font-semibold py-3 px-4 rounded-xl transition-all mb-8 shadow-lg shadow-[#49DE80]/20"
                href="/chat?new=1"
                onClick={() => setIsMobileLeftPanelOpen(false)}
              >
                <span className="material-symbols-outlined">add</span>
                Nouvelle Consultation
              </Link>
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
                onClick={openActGeneratorFromDashboard}
                title="Generer un acte"
                type="button"
              >
                <span className="material-symbols-outlined">history_edu</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Generer un acte</span> : null}
              </button>
            </nav>
          </div>
          {!isSidebarCollapsed ? (
            <SignedIn>
              <div className="flex-1 overflow-y-auto px-6">
                <p className="text-[10px] uppercase font-bold text-slate-500 tracking-widest mb-4 px-2">
                  Historique recent
                </p>
                <div className="space-y-2">
                  {recentSidebar.length === 0 ? (
                    <div className="p-3 rounded-lg border border-slate-800">
                      <p className="text-xs text-slate-500">Aucune consultation enregistree pour le moment.</p>
                    </div>
                  ) : (
                    recentSidebar.map((item) => (
                      <div
                        className="group p-3 rounded-lg hover:bg-white/5 transition-colors border border-transparent hover:border-slate-800"
                        key={item.id}
                      >
                        <div className="flex items-start gap-2">
                          <button
                            className="flex-1 min-w-0 text-left cursor-pointer"
                            onClick={() => {
                              setIsMobileLeftPanelOpen(false);
                              router.push("/chat");
                            }}
                            type="button"
                          >
                            <p className="text-sm font-medium text-slate-200 truncate">
                              {consultationTitleLabel(item)}
                            </p>
                            <p className="text-xs text-slate-500 mt-1">{formatShortDate(item.updatedAt)}</p>
                          </button>
                          <button
                            aria-label="Supprimer la conversation"
                            className="shrink-0 p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-red-950/30 transition-colors"
                            onClick={(event) => {
                              event.stopPropagation();
                              requestDeleteConsultation(item.id, item.question);
                              setIsMobileLeftPanelOpen(false);
                            }}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-base">delete</span>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </SignedIn>
          ) : null}
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto flex flex-col">
          <div
            className={`${
              isDocumentsPage
                ? "w-full pl-4 sm:pl-6 md:pl-8 lg:pl-10 pr-0 py-4 sm:py-6 md:py-8"
                : "max-w-7xl mx-auto w-full p-4 sm:p-6 md:p-10 lg:p-12"
            } space-y-8`}
          >
          <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-5">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">{title}</h2>
              <p className="text-slate-400 mt-2">Consultez et telechargez les PDF juridiques classes par domaine.</p>
            </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full xl:w-auto">
                <div className="relative group">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
                  search
                </span>
                <input
                  className="pl-9 pr-4 py-2.5 text-sm bg-[#1a2e22] border border-slate-800 rounded-xl w-full sm:w-72 focus:ring-1 focus:ring-[#49DE80] focus:border-[#49DE80] transition-all text-white placeholder:text-slate-400"
                  onChange={(event) => {
                    if (isDocumentsPage) {
                      setModelSearch(event.target.value);
                      return;
                    }
                    setCurrentPage(1);
                    setSearchTerm(event.target.value);
                  }}
                  placeholder={isDocumentsPage ? "Rechercher un modele..." : "Rechercher un document..."}
                  type="text"
                  value={isDocumentsPage ? modelSearch : searchTerm}
                />
              </div>
                <div
                  className={`${
                    isDocumentsPage ? "hidden sm:flex" : "flex"
                  } gap-2 bg-[#1a2e22] p-1 rounded-lg border border-slate-800 self-end sm:self-auto`}
                >
                  <button
                    className={`p-2 rounded ${viewMode === "list" ? "bg-[#254632] text-[#49DE80]" : "text-slate-400 hover:text-slate-200"}`}
                    onClick={() => setViewMode("list")}
                  type="button"
                >
                  <span className="material-symbols-outlined block">view_list</span>
                </button>
                <button
                  className={`p-2 rounded ${viewMode === "grid" ? "bg-[#254632] text-[#49DE80]" : "text-slate-400 hover:text-slate-200"}`}
                  onClick={() => setViewMode("grid")}
                  type="button"
                >
                  <span className="material-symbols-outlined block">grid_view</span>
                </button>
              </div>
            </div>
          </div>

          {!isDocumentsPage ? (
            <section className="xl:hidden rounded-2xl border border-slate-800 bg-[#1a2e22] p-4 space-y-3">
              <button
                className="w-full flex items-center justify-between gap-2 rounded-xl border border-slate-700 bg-[#112117] px-3 py-2.5 text-left"
                onClick={() => setIsMobileSearchPanelOpen((prev) => !prev)}
                type="button"
              >
                <div>
                  <p className="text-sm font-bold text-slate-100">Recherche + filtres documents</p>
                  <p className="text-[11px] text-slate-400">
                    {advancedSearchCount === 0
                      ? "Choisissez une categorie puis un document (optionnel)."
                      : `${advancedSearchCount} filtre(s) actif(s)`}
                  </p>
                </div>
                <span className="material-symbols-outlined text-slate-300">
                  {isMobileSearchPanelOpen ? "expand_less" : "expand_more"}
                </span>
              </button>

              {isMobileSearchPanelOpen ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Categorie</span>
                      <select
                        className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                        onChange={(event) => {
                          applySearchCategory(event.target.value);
                        }}
                        value={selectedSearchCategory}
                      >
                        <option value="all">Toutes les categories</option>
                        {searchCategoryOptions.map((category) => (
                          <option key={`mobile-search-category-${category}`} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedSearchCategory !== "all" ? (
                      <label className="space-y-1.5">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                          Type de document
                        </span>
                        <select
                          className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                          onChange={(event) => {
                            setCurrentPage(1);
                            setSelectedDocumentId(event.target.value);
                          }}
                          value={selectedDocumentId}
                        >
                          <option value="all">Tous les types de document</option>
                          {scopedSearchDocuments.map((doc) => (
                            <option key={`mobile-scoped-doc-${doc.id}`} value={doc.id}>
                              {doc.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <label className="space-y-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                        Article dans ce document
                      </span>
                      <input
                        className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                        onChange={(event) => {
                          setCurrentPage(1);
                          setArticleSearch(event.target.value);
                        }}
                        placeholder="Ex: article 45"
                        type="text"
                        value={articleSearch}
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Mot-cle</span>
                      <input
                        className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                        onChange={(event) => {
                          setCurrentPage(1);
                          setKeywordSearch(event.target.value);
                        }}
                        placeholder="Ex: succession"
                        type="text"
                        value={keywordSearch}
                      />
                    </label>
                    <label className="space-y-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Type de document</span>
                      <select
                        className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                        onChange={(event) => {
                          setCurrentPage(1);
                          setSelectedDocType(event.target.value);
                        }}
                        value={selectedDocType}
                      >
                        {docTypeOptions.map((label) => (
                          <option key={`mobile-doc-type-${label}`} value={label}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-white/5 transition-colors"
                      onClick={clearAdvancedSearch}
                      type="button"
                    >
                      <span className="material-symbols-outlined text-base">filter_alt_off</span>
                      Effacer recherche
                    </button>
                    <button
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-white/5 transition-colors"
                      onClick={resetFilters}
                      type="button"
                    >
                      <span className="material-symbols-outlined text-base">restart_alt</span>
                      Reinitialiser tout
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {!isDocumentsPage ? (
            <section className="hidden xl:block rounded-2xl border border-slate-800 bg-[#1a2e22] p-4 sm:p-6 space-y-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-100">Moteur de recherche juridique avance</h3>
                  <p className="text-sm text-slate-400">
                    Recherche multi-niveaux: article de loi, mot-cle, type d&apos;infraction et juridiction.
                  </p>
                </div>
                <span className="inline-flex items-center gap-2 self-start rounded-full border border-[#49DE80]/40 bg-[#49DE80]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-[#49DE80]">
                  <span className="material-symbols-outlined text-sm">manage_search</span>
                  Recherche multi-niveaux
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
                <label className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Categorie</span>
                  <select
                    className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                    onChange={(event) => {
                      applySearchCategory(event.target.value);
                    }}
                    value={selectedSearchCategory}
                  >
                    <option value="all">Toutes les categories</option>
                    {searchCategoryOptions.map((category) => (
                      <option key={`desktop-search-category-${category}`} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedSearchCategory !== "all" ? (
                  <label className="space-y-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Type de document
                    </span>
                    <select
                      className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                      onChange={(event) => {
                        setCurrentPage(1);
                        setSelectedDocumentId(event.target.value);
                      }}
                      value={selectedDocumentId}
                    >
                      <option value="all">Tous les types de document</option>
                      {scopedSearchDocuments.map((doc) => (
                        <option key={`desktop-scoped-doc-${doc.id}`} value={doc.id}>
                          {doc.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Article de loi</span>
                  <input
                    className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                    onChange={(event) => {
                      setCurrentPage(1);
                      setArticleSearch(event.target.value);
                    }}
                    placeholder="Ex: article 5"
                    type="text"
                    value={articleSearch}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Mot-cle</span>
                  <input
                    className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                    onChange={(event) => {
                      setCurrentPage(1);
                      setKeywordSearch(event.target.value);
                    }}
                    placeholder="Ex: succession"
                    type="text"
                    value={keywordSearch}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Type d&apos;infraction</span>
                  <input
                    className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                    onChange={(event) => {
                      setCurrentPage(1);
                      setInfractionSearch(event.target.value);
                    }}
                    placeholder="Ex: vol, abus de confiance"
                    type="text"
                    value={infractionSearch}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Juridiction</span>
                  <input
                    className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                    onChange={(event) => {
                      setCurrentPage(1);
                      setJurisdictionSearch(event.target.value);
                    }}
                    placeholder="Ex: Cour supreme"
                    type="text"
                    value={jurisdictionSearch}
                  />
                </label>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-slate-400">
                  {advancedSearchCount === 0
                    ? "Aucun filtre avance actif."
                    : `${advancedSearchCount} filtre(s) avance(s) actif(s).`}
                </p>
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-white/5 transition-colors"
                  onClick={clearAdvancedSearch}
                  type="button"
                >
                  <span className="material-symbols-outlined text-base">filter_alt_off</span>
                  Effacer la recherche avancee
                </button>
              </div>
            </section>
          ) : null}

          {isDocumentsPage ? (
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-8 xl:gap-0">
              <section className="space-y-6 xl:pr-8">
                <div className="xl:hidden flex justify-end">
                  <button
                    className="inline-flex items-center gap-2 rounded-lg bg-[#49DE80] px-3 py-2 text-xs font-bold text-[#112117] hover:bg-[#3fd273] transition-colors"
                    onClick={() => setIsMobileAiStudioOpen(true)}
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                    Generation de document
                  </button>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#1a2e22] p-3">
                  <div className="sm:hidden">
                    <label className="space-y-1.5 block">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Categorie</span>
                      <select
                        className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                        onChange={(event) => setSelectedTemplateCategory(event.target.value)}
                        value={selectedTemplateCategory}
                      >
                        {templateCategoryOptions.map((category) => (
                          <option key={`mobile-template-category-filter-${category}`} value={category}>
                            {category}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="hidden sm:flex flex-wrap gap-2">
                    {templateCategoryOptions.map((category) => {
                      const isActive = selectedTemplateCategory === category;
                      return (
                        <button
                          className={`px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors ${
                            isActive
                              ? "border-[#49DE80]/50 bg-[#49DE80]/15 text-[#49DE80]"
                              : "border-slate-700 bg-[#112117] text-slate-300 hover:border-[#49DE80]/40"
                          }`}
                          key={`template-category-filter-${category}`}
                          onClick={() => setSelectedTemplateCategory(category)}
                          type="button"
                        >
                          {category}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  {displayedTemplates.map((template) => {
                    return (
                      <article
                        className="w-full rounded-xl border border-slate-800 bg-[#1a2e22] hover:border-[#49DE80]/40 p-3 transition-colors"
                        key={template.id}
                      >
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                          <div className="text-left flex-1 min-w-0">
                            <h4 className="font-bold text-slate-100 truncate">{template.name}</h4>
                            <p className="text-[11px] text-slate-400 mt-0.5 truncate">{template.domain}</p>
                            <p className="text-xs text-slate-300 mt-2 line-clamp-2">{template.description}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-slate-800 text-slate-200 border border-slate-700 truncate">
                              {template.category}
                            </span>
                            <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[#254632] text-[#49DE80]">
                              {template.complexity}
                            </span>
                            <button
                              className="px-3 py-1.5 rounded-lg bg-[#49DE80] text-[#112117] font-bold text-xs hover:bg-[#49DE80]/90 transition-colors"
                              onClick={() => openTemplateInChat(template)}
                              type="button"
                            >
                              Utiliser
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>

                {displayedTemplates.length === 0 ? (
                  <div className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-6 text-sm text-slate-400">
                    Aucun modele ne correspond a votre recherche.
                  </div>
                ) : null}
              </section>

              <aside className="hidden xl:block w-full xl:w-80 xl:justify-self-end bg-[#1a2e22] border border-[#2c3d33] xl:border-y-0 xl:border-r-0 xl:border-l shadow-2xl rounded-2xl xl:rounded-none xl:min-h-[calc(100vh-64px)] xl:sticky xl:top-0">
                {aiStudioPanelContent}
              </aside>

              {isMobileAiStudioOpen ? (
                <>
                  <button
                    aria-label="Fermer AI Legal Studio"
                    className="xl:hidden fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]"
                    onClick={() => setIsMobileAiStudioOpen(false)}
                    type="button"
                  />
                  <div className="xl:hidden fixed inset-x-3 top-16 bottom-3 z-50">
                    <div className="relative h-full bg-[#1a2e22] border border-[#2c3d33] shadow-2xl rounded-2xl overflow-hidden flex flex-col">
                      <button
                        aria-label="Fermer"
                        className="absolute top-2 right-2 z-10 size-8 rounded-lg border border-[#2c3d33] bg-[#122118] text-slate-300"
                        onClick={() => setIsMobileAiStudioOpen(false)}
                        type="button"
                      >
                        <span className="material-symbols-outlined text-base">close</span>
                      </button>
                      {aiStudioPanelContent}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {!isDocumentsPage ? (
            <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-8">
            <aside className="hidden xl:block bg-[#1a2e22] rounded-2xl border border-slate-800 p-6 space-y-7 h-fit">
              <div>
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Type de Document</h3>
                <div className="space-y-2">
                  {docTypeOptions.map((label) => (
                    <label className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-white/5 cursor-pointer" key={label}>
                      <input
                        checked={selectedDocType === label}
                        className="text-[#49DE80] focus:ring-[#49DE80] bg-transparent border-slate-700"
                        name="doc_type"
                        onChange={() => {
                          setCurrentPage(1);
                          setSelectedDocType(label);
                        }}
                        type="radio"
                      />
                      <span className="text-sm text-slate-200">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button
                className="w-full py-2.5 bg-[#49DE80] text-[#112117] rounded-lg font-bold text-sm hover:bg-[#49DE80]/90 transition-opacity"
                onClick={resetFilters}
                type="button"
              >
                Reinitialiser les filtres
              </button>
            </aside>

            <section className="space-y-6">
              {loadingDocuments ? (
                <div className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-6 text-sm text-slate-400">
                  Chargement des PDF...
                </div>
              ) : null}

              {!loadingDocuments && documentError ? (
                <div className="rounded-2xl border border-red-900/40 bg-red-950/20 p-6 text-sm text-red-300">{documentError}</div>
              ) : null}

              {!loadingDocuments && !documentError && viewMode === "list" ? (
                <div className="bg-[#1a2e22] rounded-2xl border border-slate-800 overflow-hidden shadow-sm">
                  <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse">
                    <thead>
                      <tr className="bg-[#13231a] border-b border-slate-800">
                        <th className="text-left py-4 px-6 text-xs font-bold text-slate-400 uppercase tracking-wider w-[42%]">Document</th>
                        <th className="text-left py-4 px-6 text-xs font-bold text-slate-400 uppercase tracking-wider">Categorie</th>
                        <th className="text-right py-4 px-6 text-xs font-bold text-slate-400 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {currentRows.map((row) => (
                        <tr className="hover:bg-white/5 transition-colors group" key={row.id}>
                          <td className="py-5 px-6">
                            <div className="flex gap-4">
                              <div className={`size-10 shrink-0 rounded-lg flex items-center justify-center ${row.iconClass}`}>
                                <span className="material-symbols-outlined">{row.icon}</span>
                              </div>
                              <div>
                                <h4 className="font-bold text-slate-100 group-hover:text-[#49DE80] transition-colors">{row.title}</h4>
                                <p className="text-xs text-slate-400 mt-1 line-clamp-1">{row.description}</p>
                                {row.blockLabel || row.subCategory ? (
                                  <p className="text-[11px] text-slate-500 mt-1 line-clamp-1">
                                    {[row.blockLabel, row.subCategory].filter(Boolean).join(" • ")}
                                  </p>
                                ) : null}
                                {row.curationNote ? (
                                  <p className="text-[11px] text-amber-300/90 mt-1 line-clamp-1">{row.curationNote}</p>
                                ) : null}
                                {typeof row.matchedChunkCount === "number" && row.matchedChunkCount > 0 ? (
                                  <p className="text-[11px] text-[#49DE80] mt-1">
                                    {row.matchedChunkCount} chunk(s) pertinent(s)
                                    {Array.isArray(row.matchedPages) && row.matchedPages.length > 0
                                      ? ` | pages ${row.matchedPages.slice(0, 4).join(", ")}`
                                      : ""}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td className="py-5 px-6">
                            <span className={`px-2.5 py-1 text-[10px] font-bold uppercase rounded-full border ${row.categoryClass}`}>{row.category}</span>
                          </td>
                          <td className="py-5 px-6 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#254632] text-[#49DE80] text-xs font-bold hover:bg-[#49DE80] hover:text-[#112117] transition-all"
                                onClick={() => handleAskAi(row)}
                                type="button"
                              >
                                <span className="material-symbols-outlined text-sm">smart_toy</span>
                                IA
                              </button>
                              <button
                                className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:bg-[#254632] hover:text-[#49DE80] transition-all"
                                onClick={() => handleDownload(row)}
                                type="button"
                              >
                                <span className="material-symbols-outlined text-sm">download</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {currentRows.length === 0 ? (
                        <tr>
                          <td className="px-6 py-8 text-sm text-slate-400" colSpan={3}>
                            Aucun document ne correspond a vos filtres.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : null}

              {!loadingDocuments && !documentError && viewMode === "grid" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                  {currentRows.map((row) => (
                    <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-4" key={row.id}>
                      <div className="flex items-start gap-3 mb-3">
                        <div className={`size-10 shrink-0 rounded-lg flex items-center justify-center ${row.iconClass}`}>
                          <span className="material-symbols-outlined">{row.icon}</span>
                        </div>
                        <div>
                          <h4 className="font-bold leading-snug text-slate-100">{row.title}</h4>
                        </div>
                      </div>
                      <p className="text-sm text-slate-300 mb-2 line-clamp-2">{row.description}</p>
                      {row.blockLabel || row.subCategory ? (
                        <p className="text-[11px] text-slate-500 mb-2 line-clamp-1">
                          {[row.blockLabel, row.subCategory].filter(Boolean).join(" • ")}
                        </p>
                      ) : null}
                      {row.curationNote ? (
                        <p className="text-[11px] text-amber-300/90 mb-2 line-clamp-2">{row.curationNote}</p>
                      ) : null}
                      {typeof row.matchedChunkCount === "number" && row.matchedChunkCount > 0 ? (
                        <p className="text-[11px] text-[#49DE80] mb-3">
                          {row.matchedChunkCount} chunk(s) pertinent(s)
                          {Array.isArray(row.matchedPages) && row.matchedPages.length > 0
                            ? ` | pages ${row.matchedPages.slice(0, 3).join(", ")}`
                            : ""}
                        </p>
                      ) : null}
                      <div className="flex items-center justify-between">
                        <span className={`px-2.5 py-1 text-[10px] font-bold uppercase rounded-full border ${row.categoryClass}`}>{row.category}</span>
                        <div className="flex items-center gap-2">
                          <button className="text-[#49DE80] text-xs font-bold" onClick={() => handleAskAi(row)} type="button">
                            IA
                          </button>
                          <button className="text-slate-300 text-xs font-bold" onClick={() => handleDownload(row)} type="button">
                            Telecharger
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-2">
                <p className="text-sm text-slate-400">
                  Affichage de <span className="font-bold text-slate-100">{currentRows.length}</span> sur{" "}
                  <span className="font-bold text-slate-100">{filteredDocuments.length}</span> documents
                </p>
                <div className="flex flex-wrap gap-1">
                  <button
                    className="px-3 py-1.5 rounded-lg border border-slate-700 text-sm font-medium hover:bg-white/5 transition-colors disabled:opacity-50"
                    disabled={clampedPage <= 1}
                    onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                    type="button"
                  >
                    Precedent
                  </button>
                  {Array.from({ length: totalPages }, (_, idx) => idx + 1).slice(0, 7).map((page) => (
                    <button
                      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        page === clampedPage ? "bg-[#49DE80] text-[#112117] font-bold" : "hover:bg-white/5"
                      }`}
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      type="button"
                    >
                      {page}
                    </button>
                  ))}
                  <button
                    className="px-3 py-1.5 rounded-lg border border-slate-700 text-sm font-medium hover:bg-white/5 transition-colors disabled:opacity-50"
                    disabled={clampedPage >= totalPages}
                    onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                    type="button"
                  >
                    Suivant
                  </button>
                </div>
              </div>
            </section>
          </div>
          ) : null}
        </div>
      </main>
      </div>

      {pendingDelete ? (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#122118] shadow-2xl">
            <div className="p-5 border-b border-slate-800">
              <h3 className="text-base font-bold text-white">Confirmer la suppression</h3>
              <p className="text-sm text-slate-400 mt-2">
                Cette action supprimera la conversation de l&apos;historique.
              </p>
              <p className="text-xs text-slate-500 mt-3 line-clamp-2">
                "{pendingDelete.question}"
              </p>
            </div>
            <div className="p-4 flex items-center justify-end gap-2">
              <button
                className="px-4 py-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-white/5 transition-colors"
                onClick={cancelDeleteConsultation}
                type="button"
              >
                Annuler
              </button>
              <button
                className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-400 text-white font-semibold transition-colors"
                onClick={() => void confirmDeleteConsultation()}
                type="button"
              >
                Supprimer
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
