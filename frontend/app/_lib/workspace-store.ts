"use client";

export type ConsultationRecord = {
  id: string;
  question: string;
  answer: string;
  status: "done" | "error";
  finishReason: string;
  ragNote: string;
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceFileRecord = {
  id: string;
  name: string;
  size: number;
  addedAt: string;
};

export type TemplateComplexity = "Simple" | "Intermediaire" | "Avance";

export type CustomTemplateFieldRecord = {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  type?: "text" | "textarea" | "date" | "number" | "select";
  options?: Array<{ value: string; label: string }>;
  hint?: string;
};

export type CustomDocumentTemplateRecord = {
  id: string;
  name: string;
  category: string;
  domain: string;
  branch: string;
  complexity: TemplateComplexity;
  description: string;
  legalRefs: string[];
  requiredFields: string[];
  optionalFields: string[];
  sections: string[];
  warning: string;
  fields: CustomTemplateFieldRecord[];
  createdAt: string;
  updatedAt: string;
};

const CONSULTATIONS_KEY = "juridique_sn_consultations_v1";
const NOTES_KEY = "juridique_sn_notes_v1";
const FILES_KEY = "juridique_sn_workspace_files_v1";
const CUSTOM_TEMPLATES_KEY = "juridique_sn_custom_templates_v1";
let storageScope = "anon";

function normalizeStorageScope(scope?: string | null): string {
  const raw = String(scope ?? "").trim();
  if (!raw) {
    return "anon";
  }
  const normalized = raw.replace(/[^a-zA-Z0-9_.:@-]+/g, "_").replace(/^[_:.@-]+|[_:.@-]+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 96) : "anon";
}

function scopedKey(baseKey: string): string {
  if (storageScope === "anon") {
    return baseKey;
  }
  return `${baseKey}__${storageScope}`;
}

export function setWorkspaceStorageScope(scope?: string | null): void {
  storageScope = normalizeStorageScope(scope);
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function safeRead<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(scopedKey(key));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch {
    return fallback;
  }
}

function safeWrite<T>(key: string, value: T): void {
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(scopedKey(key), JSON.stringify(value));
  } catch {
    // Ignore quota and serialization failures in UI layer.
  }
}

function normalizeConsultation(record: ConsultationRecord): ConsultationRecord {
  const nowIso = new Date().toISOString();
  return {
    id: String(record.id),
    question: String(record.question ?? "").trim(),
    answer: String(record.answer ?? "").trim(),
    status: record.status === "error" ? "error" : "done",
    finishReason: String(record.finishReason ?? ""),
    ragNote: String(record.ragNote ?? ""),
    sourceCount: Number.isFinite(record.sourceCount) ? Math.max(0, Number(record.sourceCount)) : 0,
    createdAt: record.createdAt || nowIso,
    updatedAt: record.updatedAt || nowIso
  };
}

export function readConsultations(): ConsultationRecord[] {
  const rows = safeRead<ConsultationRecord[]>(CONSULTATIONS_KEY, []);
  if (!Array.isArray(rows)) {
    return [];
  }
  const normalized = rows
    .filter((row) => row && typeof row.id === "string")
    .map((row) => normalizeConsultation(row));
  normalized.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  return normalized;
}

export function writeConsultations(records: ConsultationRecord[]): ConsultationRecord[] {
  const normalized = records
    .filter((record) => record && typeof record.id === "string" && record.id.trim().length > 0)
    .map((record) => normalizeConsultation(record))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 50);
  safeWrite<ConsultationRecord[]>(CONSULTATIONS_KEY, normalized);
  return normalized;
}

export function upsertConsultation(record: ConsultationRecord): ConsultationRecord[] {
  const normalized = normalizeConsultation(record);
  const current = readConsultations();
  const existingIndex = current.findIndex((item) => item.id === normalized.id);
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    current[existingIndex] = {
      ...normalized,
      createdAt: existing.createdAt || normalized.createdAt
    };
  } else {
    current.unshift(normalized);
  }
  const trimmed = current.slice(0, 50);
  safeWrite(CONSULTATIONS_KEY, trimmed);
  return trimmed;
}

export function clearConsultations(): void {
  safeWrite<ConsultationRecord[]>(CONSULTATIONS_KEY, []);
}

export function removeConsultation(consultationId: string): ConsultationRecord[] {
  const normalizedId = String(consultationId ?? "").trim();
  if (!normalizedId) {
    return readConsultations();
  }
  const current = readConsultations();
  const filtered = current.filter((item) => item.id !== normalizedId);
  safeWrite<ConsultationRecord[]>(CONSULTATIONS_KEY, filtered);
  return filtered;
}

export function readWorkspaceNotes(): string {
  const value = safeRead<string>(NOTES_KEY, "");
  return typeof value === "string" ? value : "";
}

export function writeWorkspaceNotes(notes: string): void {
  safeWrite<string>(NOTES_KEY, notes);
}

function normalizeWorkspaceFile(file: WorkspaceFileRecord): WorkspaceFileRecord {
  return {
    id: String(file.id),
    name: String(file.name ?? "").trim(),
    size: Number.isFinite(file.size) ? Math.max(0, Number(file.size)) : 0,
    addedAt: file.addedAt || new Date().toISOString()
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
}

function normalizeTemplateFieldType(value: unknown): CustomTemplateFieldRecord["type"] {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "textarea") {
    return "textarea";
  }
  if (normalized === "date") {
    return "date";
  }
  if (normalized === "number") {
    return "number";
  }
  if (normalized === "select") {
    return "select";
  }
  return "text";
}

function normalizeCustomTemplateField(value: unknown): CustomTemplateFieldRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const key = String(row.key ?? "").trim();
  const label = String(row.label ?? "").trim();
  if (!key || !label) {
    return null;
  }
  const options = Array.isArray(row.options)
    ? row.options
        .map((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const parsed = option as Record<string, unknown>;
          const valueText = String(parsed.value ?? "").trim();
          const labelText = String(parsed.label ?? "").trim() || valueText;
          if (!valueText) {
            return null;
          }
          return {
            value: valueText,
            label: labelText,
          };
        })
        .filter((option): option is { value: string; label: string } => Boolean(option))
    : [];
  const type = normalizeTemplateFieldType(row.type);
  return {
    key,
    label,
    required: Boolean(row.required),
    placeholder: String(row.placeholder ?? "").trim() || undefined,
    type,
    options: type === "select" && options.length > 0 ? options : undefined,
    hint: String(row.hint ?? "").trim() || undefined,
  };
}

function normalizeTemplateComplexity(value: unknown): TemplateComplexity {
  const lowered = String(value ?? "").trim().toLowerCase();
  if (lowered === "avance") {
    return "Avance";
  }
  if (lowered === "intermediaire") {
    return "Intermediaire";
  }
  return "Simple";
}

function normalizeCustomTemplate(
  value: CustomDocumentTemplateRecord
): CustomDocumentTemplateRecord | null {
  const nowIso = new Date().toISOString();
  const id = String(value.id ?? "").trim();
  const name = String(value.name ?? "").trim();
  if (!id || !name) {
    return null;
  }
  const fields = Array.isArray(value.fields)
    ? value.fields
        .map((field) => normalizeCustomTemplateField(field))
        .filter((field): field is CustomTemplateFieldRecord => Boolean(field))
    : [];
  const requiredFields = normalizeStringList(value.requiredFields);
  const optionalFields = normalizeStringList(value.optionalFields);
  return {
    id,
    name,
    category: String(value.category ?? "").trim() || "Modeles personnalises",
    domain: String(value.domain ?? "").trim() || "Personnalise",
    branch: String(value.branch ?? "").trim() || "Document juridique",
    complexity: normalizeTemplateComplexity(value.complexity),
    description: String(value.description ?? "").trim(),
    legalRefs: normalizeStringList(value.legalRefs),
    requiredFields,
    optionalFields,
    sections: normalizeStringList(value.sections),
    warning:
      String(value.warning ?? "").trim() ||
      "Verifier la conformite du modele avec le droit senegalais avant utilisation.",
    fields,
    createdAt: String(value.createdAt ?? "").trim() || nowIso,
    updatedAt: String(value.updatedAt ?? "").trim() || nowIso,
  };
}

export function readCustomDocumentTemplates(): CustomDocumentTemplateRecord[] {
  const rows = safeRead<CustomDocumentTemplateRecord[]>(CUSTOM_TEMPLATES_KEY, []);
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => normalizeCustomTemplate(row))
    .filter((row): row is CustomDocumentTemplateRecord => Boolean(row))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function writeCustomDocumentTemplates(
  records: CustomDocumentTemplateRecord[]
): CustomDocumentTemplateRecord[] {
  const byId = new Map<string, CustomDocumentTemplateRecord>();
  for (const record of records) {
    const normalized = normalizeCustomTemplate(record);
    if (!normalized) {
      continue;
    }
    byId.set(normalized.id, normalized);
  }
  const normalizedRows = Array.from(byId.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 200);
  safeWrite<CustomDocumentTemplateRecord[]>(CUSTOM_TEMPLATES_KEY, normalizedRows);
  return normalizedRows;
}

export function upsertCustomDocumentTemplate(
  record: CustomDocumentTemplateRecord
): CustomDocumentTemplateRecord[] {
  const normalized = normalizeCustomTemplate(record);
  if (!normalized) {
    return readCustomDocumentTemplates();
  }
  const current = readCustomDocumentTemplates();
  const nextRows = [
    normalized,
    ...current.filter((row) => row.id !== normalized.id),
  ];
  return writeCustomDocumentTemplates(nextRows);
}

export function readWorkspaceFiles(): WorkspaceFileRecord[] {
  const rows = safeRead<WorkspaceFileRecord[]>(FILES_KEY, []);
  if (!Array.isArray(rows)) {
    return [];
  }
  const normalized = rows
    .filter((row) => row && typeof row.id === "string")
    .map((row) => normalizeWorkspaceFile(row));
  normalized.sort(
    (a, b) =>
      new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
  );
  return normalized;
}

export function writeWorkspaceFiles(files: WorkspaceFileRecord[]): WorkspaceFileRecord[] {
  const normalized = files.map((file) => normalizeWorkspaceFile(file)).slice(0, 50);
  safeWrite<WorkspaceFileRecord[]>(FILES_KEY, normalized);
  return normalized;
}

export function upsertWorkspaceFiles(files: WorkspaceFileRecord[]): WorkspaceFileRecord[] {
  const current = readWorkspaceFiles();
  const byId = new Map<string, WorkspaceFileRecord>();
  for (const file of current) {
    byId.set(file.id, file);
  }
  for (const file of files) {
    const normalized = normalizeWorkspaceFile(file);
    byId.set(normalized.id, normalized);
  }
  const merged = Array.from(byId.values()).sort(
    (a, b) =>
      new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
  );
  return writeWorkspaceFiles(merged);
}
