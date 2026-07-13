"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";

type Activity = "online" | "active" | "inactive" | "suspended" | "locked";

type AdminUser = {
  id: string;
  email?: string | null;
  username?: string | null;
  display_name?: string | null;
  image_url?: string | null;
  banned: boolean;
  locked: boolean;
  activity: Activity;
  created_at?: string | null;
  last_active_at?: string | null;
  last_sign_in_at?: string | null;
  two_factor_enabled: boolean;
};

type UsersResponse = {
  items: AdminUser[];
  total: number;
  limit: number;
  offset: number;
  counts: Record<Activity, number> & { active: number };
  source?: "clerk" | "workspace_users";
  management_enabled?: boolean;
  management_note?: string | null;
};

const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const pageSize = 30;

const activityLabels: Record<Activity, string> = {
  online: "En ligne",
  active: "Actif",
  inactive: "Inactif",
  suspended: "Suspendu",
  locked: "Verrouillé",
};

function relativeDate(value?: string | null) {
  if (!value) return "Jamais";
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  if (Math.abs(seconds) < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (Math.abs(seconds) < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  if (Math.abs(seconds) < 2592000) return formatter.format(Math.round(seconds / 86400), "day");
  return date.toLocaleDateString("fr-FR");
}

export function AdminUsersPanel({ currentUserId }: { currentUserId?: string }) {
  const { getToken } = useAuth();
  const [payload, setPayload] = useState<UsersResponse | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Activity>("all");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pendingUser, setPendingUser] = useState("");
  const [error, setError] = useState("");

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    return fetch(`${backendUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers || {}) },
    });
  }, [getToken]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset), active_days: "30" });
      if (submittedQuery) params.set("query", submittedQuery);
      const response = await request(`/admin/users?${params}`);
      const body = await response.json().catch(() => ({})) as UsersResponse & { detail?: string };
      if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
      setPayload(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Impossible de charger les utilisateurs.");
    } finally {
      setLoading(false);
    }
  }, [offset, request, submittedQuery]);

  useEffect(() => { void refresh(); }, [refresh]);

  const visibleUsers = useMemo(() => {
    const users = payload?.items || [];
    if (filter === "all") return users;
    if (filter === "active") return users.filter((user) => user.activity === "active" || user.activity === "online");
    return users.filter((user) => user.activity === filter);
  }, [filter, payload]);

  async function toggleBan(user: AdminUser) {
    if (user.id === currentUserId) return;
    const action = user.banned ? "réactiver" : "suspendre";
    if (!window.confirm(`Confirmer: ${action} le compte ${user.email || user.id} ?`)) return;
    setPendingUser(user.id);
    setError("");
    try {
      const response = await request(`/admin/users/${encodeURIComponent(user.id)}/${user.banned ? "unban" : "ban"}`, { method: "POST" });
      const body = await response.json().catch(() => ({})) as { detail?: string };
      if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action impossible.");
    } finally {
      setPendingUser("");
    }
  }

  return (
    <section className="admin-users">
      <div className="admin-section-title"><span>01</span><div><h2>Utilisateurs</h2><p>Comptes Clerk, activité récente et contrôle des accès.</p></div></div>

      <div className="admin-user-stats">
        <div><strong>{payload?.total ?? "–"}</strong><span>comptes</span></div>
        <div><strong>{payload?.counts?.online ?? "–"}</strong><span>en ligne</span></div>
        <div><strong>{payload?.counts?.active ?? "–"}</strong><span>actifs sur cette page</span></div>
        <div><strong>{payload?.counts?.suspended ?? "–"}</strong><span>suspendus</span></div>
      </div>

      <div className="admin-user-toolbar">
        <form onSubmit={(event) => { event.preventDefault(); setOffset(0); setSubmittedQuery(query.trim()); }}>
          <span className="material-symbols-outlined">search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nom, e-mail, identifiant Clerk…" />
          <button type="submit">Rechercher</button>
        </form>
        <div className="admin-user-filters">
          {(["all", "online", "active", "inactive", "suspended"] as const).map((value) => (
            <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)} type="button">
              {value === "all" ? "Tous" : activityLabels[value]}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="admin-error">{error}</p>}
      {payload?.management_enabled === false && <p className="admin-user-notice"><span className="material-symbols-outlined">info</span>{payload.management_note}</p>}
      <div className="admin-user-table">
        <div className="admin-user-head"><span>Utilisateur</span><span>Activité</span><span>Sécurité</span><span>Création</span><span>Action</span></div>
        {loading ? <p className="admin-empty">Chargement des comptes Clerk…</p> : visibleUsers.length === 0 ? <p className="admin-empty">Aucun utilisateur pour ce filtre.</p> : visibleUsers.map((account) => (
          <article key={account.id}>
            <div className="admin-user-person">
              {account.image_url ? <img alt="" src={account.image_url} /> : <span className="material-symbols-outlined">person</span>}
              <div><strong>{account.display_name || "Utilisateur"}{account.id === currentUserId && <em>Vous</em>}</strong><small>{account.email || account.username || account.id}</small><code>{account.id}</code></div>
            </div>
            <div><span className={`admin-activity ${account.activity}`}><i />{activityLabels[account.activity]}</span><small>{relativeDate(account.last_active_at)}</small></div>
            <div className="admin-user-security"><span className="material-symbols-outlined">{account.two_factor_enabled ? "verified_user" : "shield"}</span><small>{account.two_factor_enabled ? "2FA activée" : "2FA inactive"}</small></div>
            <div><strong>{account.created_at ? new Date(account.created_at).toLocaleDateString("fr-FR") : "–"}</strong><small>Connexion {relativeDate(account.last_sign_in_at)}</small></div>
            <button className={account.banned ? "restore" : "danger"} disabled={payload?.management_enabled === false || pendingUser === account.id || account.id === currentUserId} onClick={() => void toggleBan(account)} title={payload?.management_enabled === false ? payload.management_note || "Gestion Clerk indisponible" : undefined} type="button">
              <span className="material-symbols-outlined">{account.banned ? "person_check" : "person_cancel"}</span>{pendingUser === account.id ? "…" : account.banned ? "Réactiver" : "Suspendre"}
            </button>
          </article>
        ))}
      </div>

      <footer className="admin-user-pagination">
        <span>{payload ? `${payload.offset + 1}–${Math.min(payload.offset + payload.items.length, payload.total)} sur ${payload.total}` : "–"}</span>
        <div><button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))} type="button">Précédent</button><button disabled={!payload || offset + pageSize >= payload.total || loading} onClick={() => setOffset(offset + pageSize)} type="button">Suivant</button></div>
      </footer>
    </section>
  );
}
