"use client";
import useSWR from "swr";
import { useEffect, useMemo, useState } from "react";
import { Plus, Plug } from "lucide-react";
import toast from "react-hot-toast";
import { api } from "@/lib/api";
import { prettyError } from "@/lib/fmt";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const fetcher = (u: string) => api.get(u).then((r) => r.data);

// Where the unified notification WS lives (same one used by
// useNotificationFeed). We don't reuse that hook here because it owns
// its own list state; we only want to react to BROKER-category pushes
// to invalidate SWR, not render a feed.
const WS_BASE =
  (process.env.NEXT_PUBLIC_WS_BASE || "ws://localhost:8000") + "/api/v1";

type FormFieldDef = {
  name: string;
  label: string;
  type: "text" | "password" | "number" | "url" | "email" | "totp";
  required: boolean;
  placeholder?: string;
  help?: string;
  secret: boolean;
};

type BrokerType = {
  broker: string;
  display_name: string;
  summary: string;
  auth_kind: "oauth_daily" | "password_totp" | "long_lived_token" | "paper";
  setup_fields: FormFieldDef[];
  daily_login_fields: FormFieldDef[];
  oauth_url_template: string | null;
  docs_url: string | null;
  notes: string[];
};

type Account = {
  id: string;
  broker: string;
  client_id: string;
  label?: string | null;
  is_active: boolean;
  is_paper: boolean;
  session_valid_until?: string | null;
  last_login_at?: string | null;
  last_error?: string | null;
  credentials_public?: Record<string, any>;
};

function sessionValid(a: Account): boolean {
  if (!a.session_valid_until) return false;
  return new Date(a.session_valid_until).getTime() > Date.now();
}

// ====================================================================
// PAGE
// ====================================================================
export default function BrokersPage() {
  const { data: types } = useSWR<BrokerType[]>("/brokers/types", fetcher);
  // refreshInterval is the safety net for "scheduler fired while WS was
  // dropped"; the WS subscription below provides ~instant updates when
  // a broker login/logout/refresh fires.
  const { data: accounts, mutate: refreshAccounts } = useSWR<Account[]>(
    "/brokers",
    fetcher,
    { refreshInterval: 15_000 },
  );

  const [addOpen, setAddOpen] = useState(false);
  const [editAcc, setEditAcc] = useState<Account | null>(null);
  const [loginAcc, setLoginAcc] = useState<Account | null>(null);

  // Subscribe to the shared notification WS and trigger a refetch when
  // a BROKER-category push arrives — the scheduler emits `broker.login.success`
  // / `broker.login.failed` / `broker.logout.*` through the same bus
  // notifications use, so this catches the auto-login firing AND any
  // user-initiated login from another tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("access_token");
    if (!token) return;
    let ws: WebSocket | null = null;
    let backoff = 500;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const url = `${WS_BASE}/ws/stream?token=${encodeURIComponent(token)}`;
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }
      ws.onopen = () => {
        backoff = 500;
      };
      ws.onmessage = (m) => {
        let p: unknown;
        try {
          p = JSON.parse(m.data);
        } catch {
          return;
        }
        if (!p || typeof p !== "object") return;
        const env = p as { type?: string; data?: { category?: string; event?: string } };
        if (env.type !== "notification") return;
        const cat = env.data?.category;
        const ev = env.data?.event || "";
        // Catch both BROKER-category notifications and any event whose
        // key starts with `broker.` — covers login.success/failed/logout
        // even if the spec registry hasn't tagged it under BROKER yet.
        if (cat === "BROKER" || ev.startsWith("broker.")) {
          refreshAccounts();
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignored */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* ignored */
      }
    };
  }, [refreshAccounts]);

  const list = accounts || [];

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Broker accounts</h1>
          <p className="text-sm text-muted-foreground">
            {list.length === 0
              ? "No broker accounts connected yet."
              : `${list.length} account${list.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="w-4 h-4" />
          Add new broker
        </button>
      </header>

      {list.length === 0 ? (
        <div className="card text-center py-12">
          <Plug className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground mb-3">No broker accounts connected yet.</p>
          <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="w-4 h-4" />
            Connect your first broker
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {list.map((a) => (
            <BrokerCard
              key={a.id}
              account={a}
              types={types || []}
              onEdit={() => setEditAcc(a)}
              onLogin={() => setLoginAcc(a)}
              onRefresh={refreshAccounts}
            />
          ))}
        </div>
      )}

      {/* Add broker dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add new broker</DialogTitle>
            <DialogDescription>Connect a broker account to start trading.</DialogDescription>
          </DialogHeader>
          {!types ? (
            <div className="text-sm text-muted-foreground py-4">Loading broker definitions…</div>
          ) : (
            <ConnectBroker
              types={types}
              onConnected={() => {
                refreshAccounts();
                setAddOpen(false);
              }}
              onCancel={() => setAddOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit broker dialog */}
      <Dialog open={!!editAcc} onOpenChange={(o) => !o && setEditAcc(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          {editAcc && (
            <EditBrokerDialog
              account={editAcc}
              types={types || []}
              onSaved={() => {
                refreshAccounts();
                setEditAcc(null);
              }}
              onCancel={() => setEditAcc(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Login dialog (for non-OAuth) */}
      <Dialog open={!!loginAcc} onOpenChange={(o) => !o && setLoginAcc(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          {loginAcc && (
            <LoginBrokerDialog
              account={loginAcc}
              types={types || []}
              onDone={() => {
                refreshAccounts();
                setLoginAcc(null);
              }}
              onCancel={() => setLoginAcc(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ====================================================================
// BROKER CARD
// ====================================================================
function BrokerCard({
  account: a,
  types,
  onEdit,
  onLogin,
  onRefresh,
}: {
  account: Account;
  types: BrokerType[];
  onEdit: () => void;
  onLogin: () => void;
  onRefresh: () => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const def = types.find((t) => t.broker === a.broker);
  const valid = sessionValid(a);

  async function remove() {
    const label = `${a.broker} · ${a.client_id}`;
    const ok = await confirm({
      title: `Delete ${label}?`,
      message:
        "The encrypted credentials and saved session for this account are wiped. " +
        "Any strategy currently running on this broker will fail to place new orders. " +
        "This cannot be undone.",
      confirmLabel: "Delete account",
      cancelLabel: "Keep",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.delete(`/brokers/${a.id}`);
      toast.success("deleted");
      onRefresh();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "delete failed");
    }
  }

  async function logout() {
    const ok = await confirm({
      title: "Sign out of this broker?",
      message:
        "Any live market-data feeds tied to this session will stop, and " +
        "running strategies will be unable to place new orders until you log in again.",
      confirmLabel: "Sign out",
      cancelLabel: "Stay signed in",
      variant: "warning",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/brokers/${a.id}/logout`);
      toast.success("logged out");
      onRefresh();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "logout failed");
    } finally {
      setBusy(false);
    }
  }

async function startOAuthRedirect() {
    setBusy(true);
    try {
      const { data } = await api.get(`/brokers/${a.id}/auth-url`);
      if (data?.url) window.location.href = data.url;
      else toast.error("failed to build auth URL");
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "failed");
    } finally {
      setBusy(false);
    }
  }

  function handleLoginClick() {
    // OAuth brokers redirect straight to broker; non-OAuth opens an in-app modal.
    if (def?.auth_kind === "oauth_daily") {
      startOAuthRedirect();
    } else {
      onLogin();
    }
  }

  const sessionPill = valid
    ? "bg-profit/20 text-profit"
    : a.last_login_at
      ? "bg-warning/20 text-warning"
      : "bg-secondary text-secondary-foreground";
  const sessionLabel = valid ? "SESSION ACTIVE" : a.last_login_at ? "SESSION EXPIRED" : "NOT LOGGED IN";

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold truncate">
            {def?.display_name || a.broker}
          </h3>
          <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
            {a.client_id}
            {a.label && <span className="text-muted-foreground"> · {a.label}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {!a.is_active && <span className="pill bg-secondary text-secondary-foreground text-[10px]">DISABLED</span>}
          <span className={cn("pill font-mono text-[10px]", sessionPill)}>{sessionLabel}</span>
        </div>
      </div>

      <div className="rounded-md border border-border bg-accent/30 p-2.5 text-xs space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Last login</span>
          <span className="font-mono">
            {a.last_login_at ? new Date(a.last_login_at).toLocaleString() : "—"}
          </span>
        </div>
        {def && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Auth</span>
            <span className="font-mono text-[10px] uppercase">{def.auth_kind.replace(/_/g, " ")}</span>
          </div>
        )}
        {a.last_error && (
          <div className="text-loss text-[11px] pt-1 border-t border-border/50 mt-1">
            {prettyError(a.last_error)}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 mt-auto">
        {valid ? (
          <button className="btn-outline text-sm" onClick={logout} disabled={busy}>
            {busy ? "…" : "Logout"}
          </button>
        ) : (
          <button className="btn-outline text-sm" onClick={handleLoginClick} disabled={busy}>
            {busy ? "…" : def?.auth_kind === "long_lived_token" ? "Verify" : "Login"}
          </button>
        )}
        <button className="btn-outline text-sm" onClick={onEdit}>Edit</button>
        <button className="btn-ghost text-sm text-destructive ml-auto" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

// ====================================================================
// CONNECT (add) — used inside the Add dialog
// ====================================================================
function ConnectBroker({
  types,
  onConnected,
  onCancel,
}: {
  types: BrokerType[];
  onConnected: () => void;
  onCancel: () => void;
}) {
  const [brokerKey, setBrokerKey] = useState(types[0]?.broker || "");
  const def = useMemo(() => types.find((t) => t.broker === brokerKey), [types, brokerKey]);
  const [clientId, setClientId] = useState("");
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function setVal(name: string, v: string) {
    setValues((cur) => ({ ...cur, [name]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!def) return;
    for (const f of def.setup_fields) {
      if (f.required && !values[f.name]) {
        toast.error(`${f.label} is required`);
        return;
      }
    }
    setBusy(true);
    try {
      await api.post("/brokers", {
        broker: def.broker,
        client_id: clientId,
        label: label || null,
        // Paper / live is decided per strategy run, not per broker account.
        is_paper: false,
        credentials: values,
      });
      toast.success("broker added — daily login next");
      onConnected();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!def) return null;
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <div className="label">Broker</div>
        <select
          className="input"
          value={brokerKey}
          onChange={(e) => {
            setBrokerKey(e.target.value);
            setValues({});
          }}
        >
          {types.map((t) => (
            <option key={t.broker} value={t.broker}>{t.display_name}</option>
          ))}
        </select>
      </div>

      <div className="rounded-md border border-border bg-accent/30 p-3 text-xs">
        <div className="text-muted-foreground">{def.summary}</div>
        {def.docs_url && (
          <a className="text-primary hover:underline" href={def.docs_url} target="_blank" rel="noreferrer">
            Official docs ↗
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="label">Client ID *</div>
          <input className="input" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div>
          <div className="label">Label (optional)</div>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">One-time setup</div>
        <div className="grid grid-cols-1 gap-3">
          {def.setup_fields.map((f) => (
            <Field key={f.name} field={f} value={values[f.name] || ""} onChange={(v) => setVal(f.name, v)} />
          ))}
        </div>
      </div>

      {def.notes.length > 0 && (
        <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
          {def.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Add account"}</button>
      </div>
    </form>
  );
}

// ====================================================================
// EDIT — used inside the Edit dialog
// ====================================================================
function EditBrokerDialog({
  account,
  types,
  onSaved,
  onCancel,
}: {
  account: Account;
  types: BrokerType[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const type = types.find((t) => t.broker === account.broker);
  // `pub` starts as whatever the parent had cached (no secrets). We then
  // re-fetch with `?include_secrets=true` on mount so the form is
  // populated with the real stored values, not "(stored)" hints.
  const [pub, setPub] = useState<Record<string, unknown>>(
    () => (account.credentials_public as Record<string, unknown> | undefined) || {},
  );
  const [clientId, setClientId] = useState(account.client_id);
  const [label, setLabel] = useState(account.label || "");
  const [isActive, setIsActive] = useState(account.is_active);
  const [creds, setCreds] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (type) {
      for (const f of type.setup_fields) {
        if (!f.secret && pub[f.name] !== undefined) init[f.name] = String(pub[f.name] ?? "");
      }
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  // True while the include_secrets fetch is in flight — short-lived, but
  // worth a hint so the user doesn't see empty boxes for half a second
  // before the secrets land.
  const [loadingSecrets, setLoadingSecrets] = useState(true);

  // Fetch the account with decrypted secrets so secret fields (api_key,
  // api_secret, pin, totp_secret, etc.) pre-populate with real values
  // instead of showing the "(stored — leave blank to keep)" placeholder.
  // Scoped to a single mount per dialog open: parent unmounts the dialog
  // on close, so there's no need for SWR-style caching here.
  useEffect(() => {
    let cancelled = false;
    setLoadingSecrets(true);
    api
      .get(`/brokers/${account.id}?include_secrets=true`)
      .then((r) => {
        if (cancelled) return;
        const fresh = (r.data?.credentials_public || {}) as Record<string, unknown>;
        setPub(fresh);
        if (type) {
          const init: Record<string, string> = {};
          for (const f of type.setup_fields) {
            if (fresh[f.name] !== undefined) {
              init[f.name] = String(fresh[f.name] ?? "");
            }
          }
          setCreds(init);
        }
      })
      .catch(() => {
        // Quietly fall back to the parent-cached `pub` (no secrets). The
        // user can still edit; secret fields will just be blank with the
        // "(stored)" hint as before.
      })
      .finally(() => {
        if (!cancelled) setLoadingSecrets(false);
      });
    return () => {
      cancelled = true;
    };
    // `type` is stable per-broker per-types load; `account.id` identifies
    // the row. Re-firing the effect on either change is the correct shape.
  }, [account.id, type]);

  if (!type) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Edit broker</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-4">Broker type definition not loaded yet.</p>
        <div className="flex justify-end">
          <button className="btn-ghost" onClick={onCancel}>Close</button>
        </div>
      </>
    );
  }

  function setCred(name: string, v: string) {
    setCreds((cur) => ({ ...cur, [name]: v }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const credentialPatch: Record<string, string> = {};
      for (const f of type!.setup_fields) {
        const v = creds[f.name];
        if (v === undefined) continue;
        if (f.secret && v === "") continue;
        credentialPatch[f.name] = v;
      }
      await api.patch(`/brokers/${account.id}`, {
        label: label || null,
        // Force any legacy paper-flagged accounts back to live; paper is a
        // strategy-level choice now, not a broker-level one.
        is_paper: false,
        is_active: isActive,
        client_id: clientId,
        credentials: Object.keys(credentialPatch).length ? credentialPatch : undefined,
      });
      toast.success("updated");
      onSaved();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Edit {type.display_name}</DialogTitle>
        <DialogDescription>{account.client_id}</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="label">Client ID</div>
          <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </div>
        <div>
          <div className="label">Label</div>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>

      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active
        </label>
      </div>

      {loadingSecrets && (
        <div className="text-[10px] text-muted-foreground italic -mb-1">
          Loading stored credentials…
        </div>
      )}
      <div className="grid grid-cols-1 gap-3">
        {type.setup_fields.map((f) => {
          const stored = pub[`_has_${f.name}`] === true;
          const hasValue = (creds[f.name] ?? "") !== "";
          // Placeholder only matters when the input is empty. For a
          // secret field that exists server-side but hasn't loaded its
          // value yet (or failed to decrypt), keep the "(stored)" hint
          // so the user knows it's there. Otherwise: use the broker's
          // own placeholder.
          const placeholder =
            f.secret && stored && !hasValue
              ? "(stored — leave blank to keep)"
              : f.placeholder || "";
          return (
            <div key={f.name}>
              <div className="label">{f.label}</div>
              <input
                className="input"
                type={f.type === "totp" ? "text" : (f.type === "url" ? "url" : f.type)}
                value={creds[f.name] ?? ""}
                onChange={(e) => setCred(f.name, e.target.value)}
                placeholder={placeholder}
                autoComplete="off"
              />
              {f.help && <div className="text-xs text-muted-foreground mt-1">{f.help}</div>}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
      </div>
    </form>
  );
}

// ====================================================================
// LOGIN dialog — non-OAuth daily login (password+TOTP / long-lived)
// OAuth brokers redirect from the card, never reach this dialog.
// ====================================================================
function LoginBrokerDialog({
  account,
  types,
  onDone,
  onCancel,
}: {
  account: Account;
  types: BrokerType[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const type = types.find((t) => t.broker === account.broker);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function loginNow() {
    setBusy(true);
    try {
      await api.post(`/brokers/${account.id}/login`, values);
      toast.success("logged in");
      onDone();
    } catch (e: any) {
      toast.error(e?.response?.data?.error?.message || "login failed");
    } finally {
      setBusy(false);
    }
  }

  if (!type) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Login</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground py-4">Broker type definition not loaded yet.</p>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{type.display_name} — daily login</DialogTitle>
        <DialogDescription>
          {account.client_id}
          {account.label ? ` · ${account.label}` : ""}
        </DialogDescription>
      </DialogHeader>

      {type.daily_login_fields.length > 0 ? (
        <div className="space-y-3">
          {type.daily_login_fields.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={values[f.name] || ""}
              onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
            />
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {type.auth_kind === "password_totp"
            ? "Adapter will log in automatically using stored credentials."
            : type.auth_kind === "long_lived_token"
              ? "Long-lived token — already valid. Click verify to ping."
              : null}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={loginNow}>
          {busy ? "…" : "Login"}
        </button>
      </div>
    </div>
  );
}

// ====================================================================
// Field renderer (shared)
// ====================================================================
function Field({
  field,
  value,
  onChange,
}: {
  field: FormFieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="label">{field.label}{field.required ? " *" : ""}</div>
      <input
        className="input"
        type={field.type === "totp" ? "text" : (field.type === "url" ? "url" : field.type)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        required={field.required}
        autoComplete="off"
      />
      {field.help && <div className="text-xs text-muted-foreground mt-1">{field.help}</div>}
    </div>
  );
}
