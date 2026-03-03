"use client";

import {
  clearConsultations,
  readConsultations,
  readCustomDocumentTemplates,
  readWorkspaceFiles,
  readWorkspaceNotes,
  removeConsultation,
  setWorkspaceStorageScope,
  upsertCustomDocumentTemplate,
  upsertConsultation,
  upsertWorkspaceFiles,
  writeCustomDocumentTemplates,
  writeConsultations,
  writeWorkspaceFiles,
  writeWorkspaceNotes,
  type ConsultationRecord,
  type CustomDocumentTemplateRecord,
  type WorkspaceFileRecord,
} from "./workspace-store";

type ConsultationListResponse = {
  items: ConsultationRecord[];
};

type NotesResponse = {
  notes: string;
};

type FileListResponse = {
  items: WorkspaceFileRecord[];
};

type TemplateListResponse = {
  items: CustomDocumentTemplateRecord[];
};

type WorkspaceUserRegisterResponse = {
  status?: string;
  registered?: boolean;
  user_id?: string;
};

type UploadFilesResponse = {
  items: WorkspaceFileRecord[];
  uploaded?: Array<{
    id: string;
    name: string;
    size: number;
    chunk_count: number;
    relative_path: string;
  }>;
  errors?: Array<{
    filename: string;
    detail: string;
  }>;
};

export type LibraryDocumentRecord = {
  id: string;
  title: string;
  description: string;
  category: string;
  docType: string;
  sectionNumber?: number;
  sectionLabel?: string;
  sectionTitle?: string;
  blockCode?: string;
  blockTitle?: string;
  blockLabel?: string;
  subCategory?: string;
  curationNote?: string;
  isDuplicate?: boolean;
  folder: string;
  fileName: string;
  relativePath: string;
  size: number;
  updatedAt: string;
  downloadUrl: string;
  searchScore?: number;
  matchedChunkCount?: number;
  matchedPages?: number[];
  matchedSnippet?: string;
};

type LibraryDocumentListResponse = {
  items: LibraryDocumentRecord[];
  total: number;
};

export type LibraryChunkRecord = {
  chunk_id: string;
  text: string;
  snippet?: string;
  relative_path?: string | null;
  source_path?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  article_hint?: string | null;
};

type LibraryChunkResolveResponse = {
  items: LibraryChunkRecord[];
  requested: number;
  resolved: number;
};

type SpeechTranscriptionResponse = {
  text?: string;
  language?: string;
  model?: string;
  detail?: string;
};

let workspaceUserId: string | null = null;
let workspaceUserEmail: string | null = null;
let workspaceUserName: string | null = null;
let workspaceUserUsername: string | null = null;

type WorkspaceUserContext = {
  userId?: string | null;
  email?: string | null;
  displayName?: string | null;
  username?: string | null;
};

function normalizeWorkspaceUserId(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.replace(/[^a-zA-Z0-9_.:@-]+/g, "_").replace(/^[_:.@-]+|[_:.@-]+$/g, "");
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 96);
}

function normalizeWorkspaceHeaderText(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  return raw.slice(0, 320);
}

export function setWorkspaceUserContext(context?: WorkspaceUserContext | null): void {
  workspaceUserId = normalizeWorkspaceUserId(context?.userId ?? null);
  workspaceUserEmail = normalizeWorkspaceHeaderText(context?.email ?? null);
  workspaceUserName = normalizeWorkspaceHeaderText(context?.displayName ?? null);
  workspaceUserUsername = normalizeWorkspaceHeaderText(context?.username ?? null);
  setWorkspaceStorageScope(workspaceUserId);
}

export function setWorkspaceUserId(userId?: string | null): void {
  setWorkspaceUserContext({ userId });
}

export async function registerWorkspaceUserApi(): Promise<boolean> {
  if (!workspaceUserId) {
    return false;
  }
  const remote = await requestJson<WorkspaceUserRegisterResponse>("/workspace/users/register", {
    method: "POST",
  });
  return remote?.registered === true;
}

function backendBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:8000";
  return raw.replace(/\/+$/, "");
}

function buildHeaders(initHeaders?: HeadersInit, includeJsonContentType = true): Headers {
  const headers = new Headers(initHeaders ?? {});
  if (includeJsonContentType && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (workspaceUserId) {
    headers.set("X-User-Id", workspaceUserId);
  }
  if (workspaceUserEmail) {
    headers.set("X-User-Email", workspaceUserEmail);
  }
  if (workspaceUserName) {
    headers.set("X-User-Name", workspaceUserName);
  }
  if (workspaceUserUsername) {
    headers.set("X-User-Username", workspaceUserUsername);
  }
  return headers;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(`${backendBaseUrl()}${path}`, {
      cache: "no-store",
      ...init,
      headers: buildHeaders(init?.headers, true),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function readConsultationsApi(): Promise<ConsultationRecord[]> {
  const remote = await requestJson<ConsultationListResponse>("/workspace/consultations");
  if (remote && Array.isArray(remote.items)) {
    return writeConsultations(remote.items);
  }
  return readConsultations();
}

export async function upsertConsultationApi(
  record: ConsultationRecord
): Promise<ConsultationRecord[]> {
  const remote = await requestJson<ConsultationListResponse>("/workspace/consultations/upsert", {
    method: "PUT",
    body: JSON.stringify(record),
  });
  if (remote && Array.isArray(remote.items)) {
    return writeConsultations(remote.items);
  }
  return upsertConsultation(record);
}

export async function clearConsultationsApi(): Promise<ConsultationRecord[]> {
  const remote = await requestJson<ConsultationListResponse>("/workspace/consultations", {
    method: "DELETE",
  });
  if (remote && Array.isArray(remote.items)) {
    return writeConsultations(remote.items);
  }
  clearConsultations();
  return [];
}

export async function deleteConsultationApi(consultationId: string): Promise<ConsultationRecord[]> {
  const normalizedId = String(consultationId ?? "").trim();
  if (!normalizedId) {
    return readConsultations();
  }
  const remote = await requestJson<ConsultationListResponse>(
    `/workspace/consultations/${encodeURIComponent(normalizedId)}`,
    {
      method: "DELETE",
    }
  );
  if (remote && Array.isArray(remote.items)) {
    return writeConsultations(remote.items);
  }
  return removeConsultation(normalizedId);
}

export async function readWorkspaceNotesApi(): Promise<string> {
  const remote = await requestJson<NotesResponse>("/workspace/notes");
  if (remote && typeof remote.notes === "string") {
    writeWorkspaceNotes(remote.notes);
    return remote.notes;
  }
  return readWorkspaceNotes();
}

export async function writeWorkspaceNotesApi(notes: string): Promise<string> {
  const remote = await requestJson<NotesResponse>("/workspace/notes", {
    method: "PUT",
    body: JSON.stringify({ notes }),
  });
  if (remote && typeof remote.notes === "string") {
    writeWorkspaceNotes(remote.notes);
    return remote.notes;
  }
  writeWorkspaceNotes(notes);
  return notes;
}

export async function readWorkspaceFilesApi(): Promise<WorkspaceFileRecord[]> {
  const remote = await requestJson<FileListResponse>("/workspace/files");
  if (remote && Array.isArray(remote.items)) {
    return writeWorkspaceFiles(remote.items);
  }
  return readWorkspaceFiles();
}

export async function writeWorkspaceFilesApi(
  files: WorkspaceFileRecord[]
): Promise<WorkspaceFileRecord[]> {
  const remote = await requestJson<FileListResponse>("/workspace/files", {
    method: "PUT",
    body: JSON.stringify({ items: files }),
  });
  if (remote && Array.isArray(remote.items)) {
    return writeWorkspaceFiles(remote.items);
  }
  return writeWorkspaceFiles(files);
}

export async function upsertWorkspaceFilesApi(
  files: WorkspaceFileRecord[]
): Promise<WorkspaceFileRecord[]> {
  const remote = await requestJson<FileListResponse>("/workspace/files/upsert", {
    method: "POST",
    body: JSON.stringify({ items: files }),
  });
  if (remote && Array.isArray(remote.items)) {
    return writeWorkspaceFiles(remote.items);
  }
  return upsertWorkspaceFiles(files);
}

export async function clearWorkspaceFilesApi(): Promise<WorkspaceFileRecord[]> {
  const remote = await requestJson<FileListResponse>("/workspace/files", {
    method: "DELETE",
  });
  if (remote && Array.isArray(remote.items)) {
    return writeWorkspaceFiles(remote.items);
  }
  return writeWorkspaceFiles([]);
}

export async function readWorkspaceTemplatesApi(): Promise<CustomDocumentTemplateRecord[]> {
  const remote = await requestJson<TemplateListResponse>("/workspace/templates");
  if (remote && Array.isArray(remote.items)) {
    return writeCustomDocumentTemplates(remote.items);
  }
  return readCustomDocumentTemplates();
}

export async function upsertWorkspaceTemplateApi(
  template: CustomDocumentTemplateRecord
): Promise<CustomDocumentTemplateRecord[]> {
  const remote = await requestJson<TemplateListResponse>("/workspace/templates/upsert", {
    method: "PUT",
    body: JSON.stringify(template),
  });
  if (remote && Array.isArray(remote.items)) {
    return writeCustomDocumentTemplates(remote.items);
  }
  return upsertCustomDocumentTemplate(template);
}

export async function deleteWorkspaceTemplateApi(
  templateId: string
): Promise<CustomDocumentTemplateRecord[]> {
  const normalizedId = String(templateId ?? "").trim();
  if (!normalizedId) {
    return readCustomDocumentTemplates();
  }
  const remote = await requestJson<TemplateListResponse>(
    `/workspace/templates/${encodeURIComponent(normalizedId)}`,
    { method: "DELETE" }
  );
  if (remote && Array.isArray(remote.items)) {
    return writeCustomDocumentTemplates(remote.items);
  }
  const current = readCustomDocumentTemplates();
  const filtered = current.filter((row) => row.id !== normalizedId);
  return writeCustomDocumentTemplates(filtered);
}

export async function uploadWorkspaceFilesApi(files: File[]): Promise<{
  items: WorkspaceFileRecord[];
  uploaded: UploadFilesResponse["uploaded"];
  errors: UploadFilesResponse["errors"];
}> {
  if (files.length === 0) {
    return { items: readWorkspaceFiles(), uploaded: [], errors: [] };
  }

  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  const response = await fetch(`${backendBaseUrl()}/workspace/files/upload`, {
    method: "POST",
    headers: buildHeaders(undefined, false),
    body: formData,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload?.detail && String(payload.detail).trim().length > 0) {
        detail = String(payload.detail).trim();
      }
    } catch {
      // Keep fallback HTTP detail
    }
    throw new Error(`Upload backend failed: ${detail}`);
  }
  const payload = (await response.json()) as UploadFilesResponse;
  if (payload && Array.isArray(payload.items)) {
    const items = writeWorkspaceFiles(payload.items);
    return {
      items,
      uploaded: payload.uploaded ?? [],
      errors: payload.errors ?? [],
    };
  }
  throw new Error("Upload backend returned an invalid response.");
}

export async function listLibraryDocumentsApi(params?: {
  q?: string;
  category?: string;
  article?: string;
  keyword?: string;
  infractionType?: string;
  jurisdiction?: string;
  documentId?: string;
}): Promise<LibraryDocumentRecord[]> {
  const query = new URLSearchParams();
  if (params?.q && params.q.trim().length > 0) {
    query.set("q", params.q.trim());
  }
  if (params?.category && params.category.trim().length > 0) {
    query.set("category", params.category.trim());
  }
  if (params?.article && params.article.trim().length > 0) {
    query.set("article", params.article.trim());
  }
  if (params?.keyword && params.keyword.trim().length > 0) {
    query.set("keyword", params.keyword.trim());
  }
  if (params?.infractionType && params.infractionType.trim().length > 0) {
    query.set("infraction_type", params.infractionType.trim());
  }
  if (params?.jurisdiction && params.jurisdiction.trim().length > 0) {
    query.set("jurisdiction", params.jurisdiction.trim());
  }
  if (params?.documentId && params.documentId.trim().length > 0) {
    query.set("document_id", params.documentId.trim());
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const remote = await requestJson<LibraryDocumentListResponse>(`/library/documents${suffix}`);
  if (remote && Array.isArray(remote.items)) {
    return remote.items;
  }
  return [];
}

export async function resolveLibraryChunksApi(chunkIds: string[]): Promise<LibraryChunkRecord[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawChunkId of chunkIds) {
    const chunkId = String(rawChunkId ?? "").trim();
    if (!chunkId || seen.has(chunkId)) {
      continue;
    }
    seen.add(chunkId);
    unique.push(chunkId);
    if (unique.length >= 64) {
      break;
    }
  }
  if (unique.length === 0) {
    return [];
  }

  const remote = await requestJson<LibraryChunkResolveResponse>("/library/chunks/resolve", {
    method: "POST",
    body: JSON.stringify({ chunk_ids: unique }),
  });
  if (remote && Array.isArray(remote.items)) {
    return remote.items;
  }
  return [];
}

export function buildLibraryDownloadUrl(documentId: string): string {
  return `${backendBaseUrl()}/library/documents/${encodeURIComponent(documentId)}/download`;
}

export function buildLibraryViewUrl(documentId: string): string {
  return `${backendBaseUrl()}/library/documents/${encodeURIComponent(documentId)}/view`;
}

export async function transcribeSpeechApi(audioBlob: Blob): Promise<string> {
  const extension = audioBlob.type.includes("wav")
    ? "wav"
    : audioBlob.type.includes("ogg")
      ? "ogg"
      : audioBlob.type.includes("mp3")
        ? "mp3"
        : audioBlob.type.includes("m4a")
          ? "m4a"
          : "webm";
  const file = new File([audioBlob], `voice_input.${extension}`, {
    type: audioBlob.type || "audio/webm",
  });

  const formData = new FormData();
  formData.append("file", file, file.name);

  const response = await fetch(`${backendBaseUrl()}/speech/transcribe`, {
    method: "POST",
    body: formData,
  });

  let payload: SpeechTranscriptionResponse | null = null;
  try {
    payload = (await response.json()) as SpeechTranscriptionResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.detail || `HTTP ${response.status}`;
    throw new Error(detail);
  }

  const text = (payload?.text || "").trim();
  if (!text) {
    throw new Error("Aucune transcription detectee.");
  }
  return text;
}
