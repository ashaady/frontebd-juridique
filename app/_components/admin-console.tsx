"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type AdminJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  progress: number;
  message: string;
  file_name: string;
  folder: string;
  created_at: string;
  error?: string | null;
  result?: {
    chunks?: number;
    indexed?: number;
    pages?: number;
    articles?: number;
    taxonomy?: {
      primary_domain?: string;
      domains?: string[];
      subdomains?: string[];
      keywords?: string[];
    };
  } | null;
};

const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

const stageLabels: Record<string, string> = {
  queued: "En attente",
  extract: "Extraction",
  chunk: "Découpage",
  taxonomy: "Taxonomie",
  embedding: "Embeddings",
  publish: "Publication FAISS",
  storage: "Stockage Supabase",
  reload: "Rechargement RAG",
  completed: "Publié",
  failed: "Échec",
};

export function AdminConsole() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [folder, setFolder] = useState("Documents administrateur");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    return fetch(`${backendUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
  }, [getToken]);

  const refresh = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const me = await request("/admin/me");
      if (!me.ok) {
        setAuthorized(false);
        return;
      }
      setAuthorized(true);
      const response = await request("/admin/jobs");
      if (response.ok) {
        const payload = await response.json() as { items?: AdminJob[] };
        setJobs(Array.isArray(payload.items) ? payload.items : []);
      }
    } catch {
      setError("Le service d'administration est momentanément indisponible.");
    }
  }, [isSignedIn, request]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "processing")) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  const activeJob = useMemo(
    () => jobs.find((job) => job.status === "processing" || job.status === "queued"),
    [jobs],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setSubmitting(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      body.append("folder", folder);
      const response = await request("/admin/documents", { method: "POST", body });
      const payload = await response.json().catch(() => ({})) as AdminJob & { detail?: string };
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      setJobs((current) => [payload, ...current]);
      setFile(null);
      const input = document.getElementById("admin-pdf") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Échec de l'envoi.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!isLoaded || authorized === null) {
    return <main className="admin-shell"><div className="admin-loading">Vérification de l’accès administrateur…</div></main>;
  }
  if (!isSignedIn || authorized === false) {
    return <main className="admin-shell"><section className="admin-denied"><span className="material-symbols-outlined">shield_lock</span><h1>Accès refusé</h1><p>Ce compte Clerk n’est pas l’administrateur de JuridiqueSN.</p><Link href="/">Retour à l’application</Link></section></main>;
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <div><span className="admin-kicker">JURIDIQUESN / OPÉRATIONS</span><h1>Console documentaire</h1></div>
        <div className="admin-identity"><span className="material-symbols-outlined">verified_user</span><div><strong>{user?.fullName || "Administrateur"}</strong><small>{user?.primaryEmailAddress?.emailAddress}</small></div></div>
      </header>

      <section className="admin-grid">
        <form className="admin-upload" onSubmit={submit}>
          <div className="admin-section-title"><span>01</span><div><h2>Ajouter une source</h2><p>Le PDF sera extrait, classé, vectorisé et publié sans redémarrage.</p></div></div>
          <label className="admin-drop" htmlFor="admin-pdf">
            <span className="material-symbols-outlined">upload_file</span>
            <strong>{file?.name || "Sélectionner un document PDF"}</strong>
            <small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} Mo` : "PDF natif, 50 Mo maximum"}</small>
            <input id="admin-pdf" accept="application/pdf,.pdf" type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <label className="admin-field"><span>Dossier juridique</span><input value={folder} maxLength={80} onChange={(event) => setFolder(event.target.value)} /></label>
          {error && <p className="admin-error">{error}</p>}
          <button disabled={!file || submitting || Boolean(activeJob)} type="submit"><span className="material-symbols-outlined">neurology</span>{submitting ? "Transmission…" : activeJob ? "Un traitement est déjà actif" : "Lancer l’ingestion"}</button>
        </form>

        <aside className="admin-pipeline">
          <div className="admin-section-title"><span>02</span><div><h2>Pipeline actif</h2><p>Publication contrôlée dans l’index principal.</p></div></div>
          {activeJob ? <>
            <div className="admin-active-file"><span className="material-symbols-outlined">picture_as_pdf</span><div><strong>{activeJob.file_name}</strong><small>{stageLabels[activeJob.stage] || activeJob.stage}</small></div><b>{activeJob.progress}%</b></div>
            <div className="admin-progress"><i style={{ width: `${activeJob.progress}%` }} /></div>
            <p className="admin-stage-message">{activeJob.message}</p>
          </> : <div className="admin-idle"><span className="material-symbols-outlined">check_circle</span><strong>Index disponible</strong><p>Aucun traitement en cours.</p></div>}
          <ol className="admin-steps">{["extract", "chunk", "taxonomy", "embedding", "publish", "storage", "reload"].map((stage) => <li className={activeJob?.stage === stage ? "current" : ""} key={stage}><span />{stageLabels[stage]}</li>)}</ol>
        </aside>
      </section>

      <section className="admin-history">
        <div className="admin-section-title"><span>03</span><div><h2>Historique des publications</h2><p>Traçabilité des documents ajoutés au corpus.</p></div></div>
        <div className="admin-job-list">{jobs.length === 0 ? <p className="admin-empty">Aucune publication administrative.</p> : jobs.map((job) => <article key={job.id}>
          <div className={`admin-status ${job.status}`}>{job.status === "completed" ? "Publié" : job.status === "failed" ? "Échec" : `${job.progress}%`}</div>
          <div className="admin-job-main"><strong>{job.file_name}</strong><small>{job.folder} · {new Date(job.created_at).toLocaleString("fr-FR")}</small>{job.error && <p>{job.error}</p>}</div>
          <div className="admin-metrics"><span>{job.result?.pages ?? "–"}<small>pages</small></span><span>{job.result?.indexed ?? "–"}<small>chunks</small></span><span>{job.result?.taxonomy?.primary_domain || "–"}<small>domaine</small></span></div>
        </article>)}</div>
      </section>
    </main>
  );
}
