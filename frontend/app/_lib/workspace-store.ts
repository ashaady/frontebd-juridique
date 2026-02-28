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

const CONSULTATIONS_KEY = "juridique_sn_consultations_v1";
const NOTES_KEY = "juridique_sn_notes_v1";
const FILES_KEY = "juridique_sn_workspace_files_v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function safeRead<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
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
    window.localStorage.setItem(key, JSON.stringify(value));
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
