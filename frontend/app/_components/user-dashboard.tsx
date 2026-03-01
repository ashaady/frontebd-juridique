"use client";

import Link from "next/link";
import { SignInButton, SignedIn, SignedOut, UserButton, useUser } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import {
  listLibraryDocumentsApi,
  readConsultationsApi,
  readWorkspaceFilesApi,
} from "../_lib/workspace-api";
import { clerkUserButtonAppearance } from "../_lib/clerk-theme";
import type { ConsultationRecord, WorkspaceFileRecord } from "../_lib/workspace-store";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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

export function UserDashboard() {
  const { isLoaded, isSignedIn, user } = useUser();
  const [loading, setLoading] = useState(true);
  const [consultations, setConsultations] = useState<ConsultationRecord[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileRecord[]>([]);
  const [libraryCount, setLibraryCount] = useState(0);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    let active = true;
    const load = async () => {
      setLoading(true);
      setLoadError("");
      try {
        const [rowsConsultations, rowsFiles, rowsLibrary] = await Promise.all([
          readConsultationsApi(),
          readWorkspaceFilesApi(),
          listLibraryDocumentsApi(),
        ]);
        if (!active) {
          return;
        }
        setConsultations(rowsConsultations);
        setWorkspaceFiles(rowsFiles);
        setLibraryCount(rowsLibrary.length);
      } catch {
        if (!active) {
          return;
        }
        setLoadError("Impossible de charger toutes les statistiques pour le moment.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [isLoaded, isSignedIn]);

  const stats = useMemo(() => {
    const totalConsultations = consultations.length;
    const doneCount = consultations.filter((item) => item.status === "done").length;
    const errorCount = consultations.filter((item) => item.status === "error").length;
    const totalSources = consultations.reduce((sum, item) => sum + (item.sourceCount || 0), 0);
    const avgSources =
      totalConsultations > 0 ? (totalSources / totalConsultations).toFixed(1) : "0.0";

    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weeklyConsultations = consultations.filter((item) => {
      const createdAt = new Date(item.createdAt).getTime();
      return Number.isFinite(createdAt) && createdAt >= oneWeekAgo;
    }).length;

    const workspaceSizeBytes = workspaceFiles.reduce(
      (sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0),
      0
    );

    return {
      totalConsultations,
      doneCount,
      errorCount,
      totalSources,
      avgSources,
      weeklyConsultations,
      workspaceFileCount: workspaceFiles.length,
      workspaceSizeBytes,
      libraryCount,
    };
  }, [consultations, workspaceFiles, libraryCount]);

  const recentConsultations = useMemo(() => consultations.slice(0, 8), [consultations]);
  const displayName =
    user?.firstName?.trim() ||
    user?.fullName?.trim() ||
    user?.primaryEmailAddress?.emailAddress ||
    "Utilisateur";

  return (
    <div className="min-h-screen bg-[#112117] text-slate-100">
      <header className="flex items-center justify-between gap-4 px-4 sm:px-6 py-3 bg-white dark:bg-[#122118] border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-8 bg-[#13221a] border border-[#49DE80]/40 rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-[#49DE80] font-bold">gavel</span>
          </div>
          <p className="text-lg font-bold tracking-tight truncate">
            Juridique <span className="text-[#7ef1a9]">SN</span>
          </p>
          <span className="hidden sm:inline-flex items-center rounded-full border border-slate-700 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-300">
            Dashboard utilisateur
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            className="inline-flex items-center justify-center rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:border-[#49DE80]/60 hover:text-[#49DE80] transition-colors"
            href="/chat"
          >
            Retour chat
          </Link>
          <SignedOut>
            <SignInButton mode="modal">
              <button
                className="inline-flex items-center justify-center rounded-lg bg-[#49DE80] px-3 py-1.5 text-sm font-bold text-[#112117] hover:bg-[#3fd273] transition-colors"
                type="button"
              >
                Se connecter
              </button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <UserButton afterSignOutUrl="/sign-in" appearance={clerkUserButtonAppearance} />
          </SignedIn>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        <section className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5 sm:p-6">
          <p className="text-sm text-slate-400">Bonjour</p>
          <h1 className="text-2xl sm:text-3xl font-bold mt-1">
            {displayName}
          </h1>
          <p className="text-sm text-slate-400 mt-2">
            Suivi de votre activite, de vos consultations juridiques et de votre espace de travail.
          </p>
        </section>

        <SignedOut>
          <section className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-6 text-center">
            <p className="text-slate-300">
              Connectez-vous pour afficher vos statistiques personnelles, votre historique et vos fichiers workspace.
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <SignInButton mode="modal">
                <button
                  className="inline-flex items-center justify-center rounded-lg bg-[#49DE80] px-4 py-2 text-sm font-bold text-[#112117] hover:bg-[#3fd273] transition-colors"
                  type="button"
                >
                  Ouvrir la connexion
                </button>
              </SignInButton>
              <Link
                className="inline-flex items-center justify-center rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-[#49DE80]/60 hover:text-[#49DE80] transition-colors"
                href="/bibliotheque"
              >
                Voir la bibliotheque
              </Link>
            </div>
          </section>
        </SignedOut>

        <SignedIn>
          {loading ? (
            <section className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-6 text-sm text-slate-400">
              Chargement des indicateurs...
            </section>
          ) : null}

          {!loading && loadError ? (
            <section className="rounded-2xl border border-red-900/40 bg-red-950/20 p-6 text-sm text-red-300">
              {loadError}
            </section>
          ) : null}

          {!loading ? (
            <>
              <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Consultations totales</p>
                  <p className="text-3xl font-bold mt-2">{stats.totalConsultations}</p>
                </article>
                <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Cette semaine</p>
                  <p className="text-3xl font-bold mt-2">{stats.weeklyConsultations}</p>
                </article>
                <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Sources citees</p>
                  <p className="text-3xl font-bold mt-2">{stats.totalSources}</p>
                  <p className="text-xs text-slate-400 mt-1">Moyenne: {stats.avgSources} par consultation</p>
                </article>
                <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5">
                  <p className="text-xs uppercase tracking-wider text-slate-400">Fichiers workspace</p>
                  <p className="text-3xl font-bold mt-2">{stats.workspaceFileCount}</p>
                  <p className="text-xs text-slate-400 mt-1">Volume: {formatBytes(stats.workspaceSizeBytes)}</p>
                </article>
              </section>

              <section className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-4">
                <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5">
                  <div className="flex items-center justify-between gap-2 mb-4">
                    <h2 className="text-lg font-bold">Historique recent</h2>
                    <Link
                      className="text-sm font-semibold text-[#49DE80] hover:text-[#7ef1a9]"
                      href="/chat"
                    >
                      Ouvrir le chat
                    </Link>
                  </div>
                  {recentConsultations.length === 0 ? (
                    <p className="text-sm text-slate-400">Aucune consultation enregistree pour le moment.</p>
                  ) : (
                    <div className="space-y-2">
                      {recentConsultations.map((item) => (
                        <Link
                          className="block rounded-xl border border-slate-800 p-3 hover:border-[#49DE80]/50 hover:bg-[#0f1d15] transition-colors"
                          href={`/chat?q=${encodeURIComponent(item.question)}`}
                          key={item.id}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-semibold line-clamp-1">{item.question}</p>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                                item.status === "done"
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : "bg-red-500/20 text-red-300"
                              }`}
                            >
                              {item.status}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 mt-1">
                            {formatShortDate(item.updatedAt)} | sources: {item.sourceCount}
                          </p>
                        </Link>
                      ))}
                    </div>
                  )}
                </article>

                <article className="rounded-2xl border border-slate-800 bg-[#1a2e22] p-5">
                  <h2 className="text-lg font-bold mb-4">Actions rapides</h2>
                  <div className="space-y-2">
                    <Link
                      className="flex items-center justify-between rounded-xl border border-slate-800 p-3 hover:border-[#49DE80]/50 hover:bg-[#0f1d15] transition-colors"
                      href="/chat"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        <span className="material-symbols-outlined text-base">chat</span>
                        Nouvelle consultation
                      </span>
                      <span className="material-symbols-outlined text-base text-slate-400">north_east</span>
                    </Link>
                    <Link
                      className="flex items-center justify-between rounded-xl border border-slate-800 p-3 hover:border-[#49DE80]/50 hover:bg-[#0f1d15] transition-colors"
                      href="/bibliotheque"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        <span className="material-symbols-outlined text-base">library_books</span>
                        Parcourir les codes & lois
                      </span>
                      <span className="material-symbols-outlined text-base text-slate-400">north_east</span>
                    </Link>
                    <Link
                      className="flex items-center justify-between rounded-xl border border-slate-800 p-3 hover:border-[#49DE80]/50 hover:bg-[#0f1d15] transition-colors"
                      href="/bibliotheque-v2"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        <span className="material-symbols-outlined text-base">description</span>
                        Ouvrir les modeles d'actes
                      </span>
                      <span className="material-symbols-outlined text-base text-slate-400">north_east</span>
                    </Link>
                  </div>

                  <div className="mt-5 rounded-xl border border-slate-800 bg-[#112117] p-3">
                    <p className="text-xs uppercase tracking-wider text-slate-400">Catalogue juridique</p>
                    <p className="text-2xl font-bold mt-1">{stats.libraryCount}</p>
                    <p className="text-xs text-slate-400">documents disponibles dans la bibliotheque</p>
                  </div>

                  <div className="mt-3 rounded-xl border border-slate-800 bg-[#112117] p-3">
                    <p className="text-xs uppercase tracking-wider text-slate-400">Taux de reussite</p>
                    <p className="text-2xl font-bold mt-1">
                      {stats.totalConsultations > 0
                        ? `${Math.round((stats.doneCount / stats.totalConsultations) * 100)}%`
                        : "0%"}
                    </p>
                    <p className="text-xs text-slate-400">
                      {stats.doneCount} reussies / {stats.errorCount} en erreur
                    </p>
                  </div>
                </article>
              </section>
            </>
          ) : null}
        </SignedIn>
      </main>
    </div>
  );
}
