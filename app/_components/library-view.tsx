"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignInButton, SignedIn, SignedOut, UserButton, useAuth } from "@clerk/nextjs";
import {
  buildLibraryViewUrl,
  deleteConsultationApi,
  listLibraryDocumentsApi,
  readConsultationsApi,
  type LibraryDocumentRecord,
} from "../_lib/workspace-api";
import { type ConsultationRecord } from "../_lib/workspace-store";
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

type TemplateComplexity = "Simple" | "Intermediaire" | "Avance";

type DocumentTemplate = {
  id: string;
  name: string;
  domain: string;
  complexity: TemplateComplexity;
  description: string;
  legalRefs: string[];
  requiredFields: string[];
  optionalFields: string[];
  sections: string[];
  warning: string;
};

const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  {
    id: "contrat-bail",
    name: "Contrat de bail",
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
  const { isLoaded: isAuthLoaded, isSignedIn } = useAuth();
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
  const [selectedDocumentId, setSelectedDocumentId] = useState("all");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedDocType, setSelectedDocType] = useState<DocTypeFilter>("Tous");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [currentPage, setCurrentPage] = useState(1);
  const [modelSearch, setModelSearch] = useState("");
  const [selectedModelDomain, setSelectedModelDomain] = useState<string>("Tous");
  const [selectedModelComplexity, setSelectedModelComplexity] = useState<string>("Tous");
  const [favoriteModelIds, setFavoriteModelIds] = useState<string[]>([]);
  const [recentModelIds, setRecentModelIds] = useState<string[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>(DOCUMENT_TEMPLATES[0]?.id ?? "");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileLeftPanelOpen, setIsMobileLeftPanelOpen] = useState(false);

  const isDocumentsPage = title.toLowerCase().includes("documents");

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

  useEffect(() => {
    if (selectedDocumentId === "all") {
      return;
    }
    if (allLibraryDocuments.some((doc) => doc.id === selectedDocumentId)) {
      return;
    }
    setSelectedDocumentId("all");
  }, [allLibraryDocuments, selectedDocumentId]);

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

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const category of categories) {
      map.set(category, 0);
    }
    for (const doc of documents) {
      map.set(doc.category, (map.get(doc.category) ?? 0) + 1);
    }
    return map;
  }, [documents, categories]);

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

  const modelDomains = useMemo(() => {
    const values = Array.from(new Set(DOCUMENT_TEMPLATES.map((template) => template.domain)));
    return ["Tous", ...values.sort((a, b) => a.localeCompare(b, "fr"))];
  }, []);

  const modelComplexities = useMemo(
    () => ["Tous", "Simple", "Intermediaire", "Avance"] as const,
    []
  );

  const filteredTemplates = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return DOCUMENT_TEMPLATES.filter((template) => {
      if (selectedModelDomain !== "Tous" && template.domain !== selectedModelDomain) {
        return false;
      }
      if (selectedModelComplexity !== "Tous" && template.complexity !== selectedModelComplexity) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = `${template.name} ${template.description} ${template.domain} ${template.legalRefs.join(" ")}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [modelSearch, selectedModelDomain, selectedModelComplexity]);

  const selectedTemplate = useMemo(() => {
    const byId = filteredTemplates.find((item) => item.id === selectedModelId);
    if (byId) {
      return byId;
    }
    return filteredTemplates[0] ?? null;
  }, [filteredTemplates, selectedModelId]);

  const recentTemplates = useMemo(() => {
    const byId = new Map(DOCUMENT_TEMPLATES.map((item) => [item.id, item]));
    return recentModelIds.map((id) => byId.get(id)).filter((item): item is DocumentTemplate => Boolean(item));
  }, [recentModelIds]);

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

  const toggleCategory = (category: string, checked: boolean) => {
    setCurrentPage(1);
    setSelectedCategories((previous) => {
      if (checked) {
        if (previous.includes(category)) {
          return previous;
        }
        return [...previous, category];
      }
      return previous.filter((item) => item !== category);
    });
  };

  const resetFilters = () => {
    setSearchTerm("");
    setSelectedCategories(categories);
    setSelectedDocType("Tous");
    setArticleSearch("");
    setKeywordSearch("");
    setInfractionSearch("");
    setJurisdictionSearch("");
    setSelectedDocumentId("all");
    setCurrentPage(1);
  };

  const clearAllCategories = () => {
    setCurrentPage(1);
    setSelectedCategories([]);
  };

  const clearAdvancedSearch = () => {
    setCurrentPage(1);
    setArticleSearch("");
    setKeywordSearch("");
    setInfractionSearch("");
    setJurisdictionSearch("");
    setSelectedDocumentId("all");
  };

  const advancedSearchCount = [
    articleSearch,
    keywordSearch,
    infractionSearch,
    jurisdictionSearch,
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

  const toggleFavoriteModel = (templateId: string) => {
    setFavoriteModelIds((previous) => {
      if (previous.includes(templateId)) {
        return previous.filter((id) => id !== templateId);
      }
      return [templateId, ...previous].slice(0, 20);
    });
  };

  const markRecentTemplate = (templateId: string) => {
    setRecentModelIds((previous) => [templateId, ...previous.filter((id) => id !== templateId)].slice(0, 10));
  };

  const openTemplateInChat = (template: DocumentTemplate) => {
    if (!requireSignedIn()) {
      return;
    }
    markRecentTemplate(template.id);
    const prompt = `Je veux utiliser le modele "${template.name}". Pose les questions manquantes puis genere un document structure conforme au droit applicable.`;
    openChatWithQuestion(prompt);
  };

  return (
    <div className="min-h-screen lg:h-screen flex flex-col overflow-x-hidden lg:overflow-hidden bg-[#112117] text-slate-100">
      <SignedOut>
        <SignInButton mode="modal">
          <button ref={signInModalTriggerRef} type="button" className="hidden" aria-hidden="true" />
        </SignInButton>
      </SignedOut>
      <header className="flex items-center gap-4 px-3 sm:px-6 py-3 bg-white dark:bg-[#122118] border-b border-slate-200 dark:border-slate-800 shrink-0 z-20">
        <div className={`${isSidebarCollapsed ? "lg:w-16" : "lg:w-72"} flex items-center gap-2 shrink-0 min-w-0`}>
          <div className="size-8 bg-primary rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-[#0a120e] font-bold">gavel</span>
          </div>
          <h1 className={`text-lg font-bold tracking-tight truncate ${isSidebarCollapsed ? "lg:hidden" : ""}`}>
            LegalAI <span className="text-primary">Senegal</span>
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
            <UserButton afterSignOutUrl="/sign-in" appearance={clerkUserButtonAppearance} />
          </SignedIn>
        </div>
        <div className="lg:hidden flex items-center gap-2">
          <button
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 hover:bg-slate-50 dark:hover:bg-[#1e2e24]"
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
          <Link
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 hover:bg-slate-50 dark:hover:bg-[#1e2e24]"
            href="/chat"
          >
            <span className="material-symbols-outlined text-base">chat</span>
          </Link>
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
              <div className={`flex items-center ${isSidebarCollapsed ? "" : "gap-3"}`}>
                <div
                  className={`${isSidebarCollapsed ? "size-9" : "size-10"} bg-[#1a2e22] border border-[#49DE80]/40 rounded-lg flex items-center justify-center shadow-lg shadow-[#49DE80]/10`}
                >
                  <span className="material-symbols-outlined text-[#49DE80] font-bold">gavel</span>
                </div>
                {!isSidebarCollapsed ? <span className="text-lg font-bold tracking-tight">JuridiqueSN</span> : null}
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
              <Link
                className="w-full flex items-center gap-3 bg-[#49DE80] hover:bg-[#49DE80]/90 text-[#112117] font-semibold py-3 px-4 rounded-xl transition-all mb-8 shadow-lg shadow-[#49DE80]/20"
                href="/chat"
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
                href="/dashboard"
                onClick={() => setIsMobileLeftPanelOpen(false)}
                title="Dashboard"
              >
                <span className="material-symbols-outlined">space_dashboard</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Dashboard</span> : null}
              </Link>
              <Link
                className={`flex items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white transition-colors ${
                  isSidebarCollapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5"
                }`}
                href="/bibliotheque"
                onClick={() => setIsMobileLeftPanelOpen(false)}
                title="Codes & Lois"
              >
                <span className="material-symbols-outlined">library_books</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Codes &amp; Lois</span> : null}
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
                onClick={() => openChatWithQuestion("Verifier un contrat au regard du droit senegalais.")}
                title="Verifier un contrat"
                type="button"
              >
                <span className="material-symbols-outlined">rule</span>
                {!isSidebarCollapsed ? <span className="text-sm font-medium">Verifier un contrat</span> : null}
              </button>
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
                            onClick={() => openChatWithQuestion(item.question)}
                            type="button"
                          >
                            <p className="text-sm font-medium text-slate-200 truncate">{item.question}</p>
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
          <div className="max-w-7xl mx-auto w-full p-4 sm:p-6 md:p-10 lg:p-12 space-y-8">
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
                    setCurrentPage(1);
                    setSearchTerm(event.target.value);
                  }}
                  placeholder="Rechercher un document..."
                  type="text"
                  value={searchTerm}
                />
              </div>
              <div className="flex gap-2 bg-[#1a2e22] p-1 rounded-lg border border-slate-800 self-end sm:self-auto">
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
            <section className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-4 sm:p-6 space-y-4">
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

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                <label className="space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Document juridique</span>
                  <select
                    className="w-full rounded-xl border border-slate-800 bg-[#112117] px-3 py-2.5 text-sm text-slate-100 focus:border-[#49DE80] focus:ring-1 focus:ring-[#49DE80]"
                    onChange={(event) => {
                      setCurrentPage(1);
                      setSelectedDocumentId(event.target.value);
                    }}
                    value={selectedDocumentId}
                  >
                    <option value="all">Tous les documents</option>
                    {allLibraryDocuments.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.title}
                      </option>
                    ))}
                  </select>
                </label>
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
            <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-8">
              <aside className="bg-[#1a2e22] rounded-2xl border border-slate-800 p-6 space-y-6 h-fit">
                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Recherche modele</h3>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">
                      search
                    </span>
                    <input
                      className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-[#112117] border border-slate-800 text-sm text-slate-100 placeholder:text-slate-500 focus:ring-1 focus:ring-[#49DE80] focus:border-[#49DE80]"
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="Bail, plainte, OHADA..."
                      type="text"
                      value={modelSearch}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Domaine</h3>
                  <select
                    className="w-full py-2.5 px-3 rounded-xl bg-[#112117] border border-slate-800 text-sm text-slate-100 focus:ring-1 focus:ring-[#49DE80] focus:border-[#49DE80]"
                    onChange={(event) => setSelectedModelDomain(event.target.value)}
                    value={selectedModelDomain}
                  >
                    {modelDomains.map((domain) => (
                      <option key={domain} value={domain}>
                        {domain}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Complexite</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {modelComplexities.map((level) => (
                      <button
                        className={`py-2 px-2 rounded-lg text-xs font-semibold border transition-colors ${
                          selectedModelComplexity === level
                            ? "bg-[#254632] text-[#49DE80] border-[#49DE80]/30"
                            : "bg-[#112117] text-slate-300 border-slate-800 hover:border-[#49DE80]/40"
                        }`}
                        key={level}
                        onClick={() => setSelectedModelComplexity(level)}
                        type="button"
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-[#112117] p-4">
                  <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2">Historique modeles utilises</p>
                  {recentTemplates.length === 0 ? (
                    <p className="text-xs text-slate-500">Aucun modele utilise recemment.</p>
                  ) : (
                    <div className="space-y-2">
                      {recentTemplates.map((template) => (
                        <button
                          className="w-full text-left px-2 py-2 rounded-lg hover:bg-white/5 transition-colors"
                          key={`recent-${template.id}`}
                          onClick={() => setSelectedModelId(template.id)}
                          type="button"
                        >
                          <p className="text-sm text-slate-200 truncate">{template.name}</p>
                          <p className="text-[11px] text-slate-500">{template.domain}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </aside>

              <section className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                  {filteredTemplates.map((template) => {
                    const isSelected = selectedTemplate?.id === template.id;
                    const isFavorite = favoriteModelIds.includes(template.id);
                    return (
                      <article
                        className={`rounded-2xl border p-4 transition-colors ${
                          isSelected
                            ? "border-[#49DE80]/50 bg-[#1f3527]"
                            : "border-slate-800 bg-[#1a2e22] hover:border-[#49DE80]/40"
                        }`}
                        key={template.id}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            className="text-left flex-1"
                            onClick={() => setSelectedModelId(template.id)}
                            type="button"
                          >
                            <h4 className="font-bold text-slate-100">{template.name}</h4>
                            <p className="text-xs text-slate-400 mt-1">{template.domain}</p>
                          </button>
                          <button
                            className={`p-1.5 rounded-md border transition-colors ${
                              isFavorite
                                ? "text-amber-300 border-amber-400/40 bg-amber-500/10"
                                : "text-slate-500 border-slate-700 hover:text-amber-300 hover:border-amber-400/30"
                            }`}
                            onClick={() => toggleFavoriteModel(template.id)}
                            title={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
                            type="button"
                          >
                            <span className="material-symbols-outlined text-base">star</span>
                          </button>
                        </div>
                        <p className="text-sm text-slate-300 mt-3 line-clamp-3">{template.description}</p>
                        <div className="flex items-center justify-between mt-4">
                          <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[#254632] text-[#49DE80]">
                            {template.complexity}
                          </span>
                          <button
                            className="text-xs font-bold text-[#49DE80]"
                            onClick={() => setSelectedModelId(template.id)}
                            type="button"
                          >
                            Apercu
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>

                {filteredTemplates.length === 0 ? (
                  <div className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-6 text-sm text-slate-400">
                    Aucun modele ne correspond a votre recherche.
                  </div>
                ) : null}

                {selectedTemplate ? (
                  <div className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-6 space-y-6">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-100">{selectedTemplate.name}</h3>
                        <p className="text-slate-400 mt-1">{selectedTemplate.description}</p>
                        <div className="flex flex-wrap gap-2 mt-3">
                          {selectedTemplate.legalRefs.map((ref) => (
                            <span
                              className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#254632] text-[#49DE80] border border-[#49DE80]/30"
                              key={`${selectedTemplate.id}-ref-${ref}`}
                            >
                              {ref}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="px-4 py-2 rounded-lg bg-[#49DE80] text-[#112117] font-bold text-sm hover:bg-[#49DE80]/90 transition-colors"
                          onClick={() => openTemplateInChat(selectedTemplate)}
                          type="button"
                        >
                          Utiliser ce modele
                        </button>
                        <button
                          className="px-4 py-2 rounded-lg border border-slate-700 text-slate-200 text-sm hover:bg-white/5 transition-colors"
                          onClick={() => toggleFavoriteModel(selectedTemplate.id)}
                          type="button"
                        >
                          {favoriteModelIds.includes(selectedTemplate.id) ? "Retirer favori" : "Ajouter favori"}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                      <div className="rounded-xl border border-slate-800 bg-[#112117] p-4">
                        <h4 className="text-sm font-bold text-slate-200 mb-3">Champs obligatoires</h4>
                        <ul className="space-y-2">
                          {selectedTemplate.requiredFields.map((field) => (
                            <li className="text-sm text-slate-300 flex items-start gap-2" key={`${selectedTemplate.id}-req-${field}`}>
                              <span className="material-symbols-outlined text-[16px] text-[#49DE80] mt-0.5">check_circle</span>
                              <span>{field}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-[#112117] p-4">
                        <h4 className="text-sm font-bold text-slate-200 mb-3">Champs optionnels</h4>
                        {selectedTemplate.optionalFields.length === 0 ? (
                          <p className="text-sm text-slate-500">Aucun champ optionnel.</p>
                        ) : (
                          <ul className="space-y-2">
                            {selectedTemplate.optionalFields.map((field) => (
                              <li className="text-sm text-slate-300 flex items-start gap-2" key={`${selectedTemplate.id}-opt-${field}`}>
                                <span className="material-symbols-outlined text-[16px] text-slate-500 mt-0.5">radio_button_unchecked</span>
                                <span>{field}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-[#112117] p-4">
                      <h4 className="text-sm font-bold text-slate-200 mb-3">Structure du document</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {selectedTemplate.sections.map((sectionName) => (
                          <div className="text-sm text-slate-300 px-3 py-2 rounded-lg bg-[#1a2e22]" key={`${selectedTemplate.id}-section-${sectionName}`}>
                            {sectionName}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-4">
                      <h4 className="text-sm font-bold text-amber-300 mb-2">Avertissement juridique</h4>
                      <p className="text-sm text-amber-100/90">{selectedTemplate.warning}</p>
                      <p className="text-xs text-amber-200/70 mt-2">
                        Ce modele doit etre adapte a votre situation et valide par un professionnel du droit.
                      </p>
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}

          {!isDocumentsPage ? (
            <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-8">
            <aside className="bg-[#1a2e22] rounded-2xl border border-slate-800 p-6 space-y-7 h-fit">
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Categories</h3>
                  <button
                    className="text-[11px] font-semibold text-[#112117] bg-[#49DE80] hover:bg-[#49DE80]/90 px-2.5 py-1 rounded-md transition-colors"
                    onClick={clearAllCategories}
                    type="button"
                  >
                    Tout deselectionner
                  </button>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {categories.map((category) => (
                    <label className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-white/5 cursor-pointer" key={category}>
                      <input
                        checked={selectedCategories.includes(category)}
                        className="rounded border-slate-700 text-[#49DE80] focus:ring-[#49DE80] bg-transparent"
                        onChange={(event) => toggleCategory(category, event.target.checked)}
                        type="checkbox"
                      />
                      <span className="text-sm text-slate-200">{category}</span>
                      <span className="ml-auto text-xs text-slate-500">{categoryCounts.get(category) ?? 0}</span>
                    </label>
                  ))}
                  {categories.length === 0 ? <p className="text-xs text-slate-500">Aucune categorie.</p> : null}
                </div>
              </div>

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
