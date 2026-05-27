"use client";

/**
 * Settings page card for the centralised Notification System.
 *
 * Reads from / writes to ``GET|PUT /notifications/preferences``.
 * Each external channel (Email / Telegram / Discord / Webhook)
 * gets its own row with:
 *   - on/off toggle
 *   - target field (chat_id, email address, webhook URL, phone)
 *   - minimum severity dropdown
 *   - category whitelist (empty = all)
 *
 * Below that: silent-mode schedule, rate limit, sound config, browser
 * push enable, auto-expiry days, and a "Send test" button per channel.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCw,
  Send,
  X,
  Zap,
} from "lucide-react";
import useSWR from "swr";
import { api } from "@/lib/api";
import {
  NotificationCategory,
  NotificationChannel,
  NotificationSeverity,
  SEVERITY_ORDER,
  requestBrowserPermission,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

type ChannelConfig = {
  enabled: boolean;
  target: string;
  categories: NotificationCategory[];
  severity_min: NotificationSeverity;
  // Telegram (per-user). On read these always come back empty / false-y
  // — the actual encrypted token lives server-side. On write, an empty
  // string preserves the existing value; a non-empty string replaces it.
  bot_token?: string;
  has_bot_token?: boolean;
  // Email / SMTP (per-user). Same preserve-on-empty pattern for the
  // password; the rest are plain.
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_from?: string;
  smtp_use_tls?: boolean;
  smtp_password?: string;
  has_smtp_password?: boolean;
};

type EmailProvider = {
  key: string;
  label: string;
  host: string;
  port: number;
  use_tls: boolean;
  hint: string;
  app_password_url: string | null;
};

type SilentMode = {
  enabled: boolean;
  start: string;
  end: string;
  tz: string;
};

type SoundConfig = {
  critical: boolean;
  error: boolean;
  warning: boolean;
  info: boolean;
};

type Preferences = {
  channels: Record<NotificationChannel, ChannelConfig>;
  strategies_muted: string[];
  brokers_muted: string[];
  silent_mode: SilentMode;
  rate_limit: { per_minute: number; per_hour: number };
  sound: SoundConfig;
  browser_push: boolean;
  desktop_push: boolean;
  auto_expiry_days: number;
};

type ChannelStatus = {
  configured: boolean;
  bot_username?: string | null;
  deep_link?: string | null;
  detail?: string;
};

type TelegramChat = {
  chat_id: string;
  name: string;
  type: string;
  last_message: string;
  username?: string | null;
};

const CATEGORIES: NotificationCategory[] = [
  "AUTH",
  "BROKER",
  "STRATEGY",
  "SIGNAL",
  "ORDER",
  "TRADE",
  "RISK",
  "MARKET_DATA",
  "SYSTEM",
  "SCHEDULER",
  "AUTOMATION",
  "ADMIN",
];

const EXTERNAL_CHANNELS: {
  ch: NotificationChannel;
  label: string;
  targetLabel: string;
  targetHint: string;
}[] = [
  { ch: "EMAIL", label: "Email", targetLabel: "Recipient", targetHint: "notify-me@example.com" },
  { ch: "TELEGRAM", label: "Telegram", targetLabel: "Chat ID", targetHint: "123456789" },
  { ch: "DISCORD", label: "Discord", targetLabel: "Webhook URL", targetHint: "https://discord.com/api/webhooks/..." },
  { ch: "WEBHOOK", label: "Generic Webhook", targetLabel: "URL", targetHint: "https://example.com/hook" },
];

const fetcher = (u: string) => api.get(u).then((r) => r.data);

const ALL_CHANNELS: NotificationChannel[] = [
  "IN_APP",
  "EMAIL",
  "TELEGRAM",
  "DISCORD",
  "WEBHOOK",
];

function defaultChannelConfig(ch: NotificationChannel): ChannelConfig {
  return {
    enabled: ch === "IN_APP",
    target: "",
    categories: [],
    severity_min:
      ch === "TELEGRAM"
        ? "ERROR"
        : ch === "EMAIL"
          ? "WARNING"
          : "INFO",
    bot_token: "",
    has_bot_token: false,
    smtp_host: "",
    smtp_port: 587,
    smtp_user: "",
    smtp_from: "",
    smtp_use_tls: true,
    smtp_password: "",
    has_smtp_password: false,
  };
}

function defaultPreferences(): Preferences {
  const channels = {} as Record<NotificationChannel, ChannelConfig>;
  for (const c of ALL_CHANNELS) channels[c] = defaultChannelConfig(c);
  return {
    channels,
    strategies_muted: [],
    brokers_muted: [],
    silent_mode: { enabled: false, start: "22:00", end: "07:00", tz: "Asia/Kolkata" },
    rate_limit: { per_minute: 30, per_hour: 300 },
    sound: { critical: true, error: true, warning: false, info: false },
    browser_push: true,
    desktop_push: false,
    auto_expiry_days: 30,
  };
}

/** Merge backend payload with defaults so missing keys never throw. */
function normalizePreferences(p: Partial<Preferences> | undefined): Preferences {
  const base = defaultPreferences();
  if (!p) return base;
  const channels = { ...base.channels };
  for (const c of ALL_CHANNELS) {
    const incoming = p.channels?.[c];
    if (incoming) {
      channels[c] = {
        enabled: !!incoming.enabled,
        target: incoming.target ?? "",
        categories: Array.isArray(incoming.categories) ? incoming.categories : [],
        severity_min: incoming.severity_min ?? base.channels[c].severity_min,
        bot_token: "",
        has_bot_token: !!incoming.has_bot_token,
        smtp_host: incoming.smtp_host ?? "",
        smtp_port: incoming.smtp_port ?? 587,
        smtp_user: incoming.smtp_user ?? "",
        smtp_from: incoming.smtp_from ?? "",
        smtp_use_tls: incoming.smtp_use_tls ?? true,
        smtp_password: "",
        has_smtp_password: !!incoming.has_smtp_password,
      };
    }
  }
  return {
    channels,
    strategies_muted: p.strategies_muted ?? base.strategies_muted,
    brokers_muted: p.brokers_muted ?? base.brokers_muted,
    silent_mode: { ...base.silent_mode, ...(p.silent_mode ?? {}) },
    rate_limit: { ...base.rate_limit, ...(p.rate_limit ?? {}) },
    sound: { ...base.sound, ...(p.sound ?? {}) },
    browser_push: p.browser_push ?? base.browser_push,
    desktop_push: p.desktop_push ?? base.desktop_push,
    auto_expiry_days: p.auto_expiry_days ?? base.auto_expiry_days,
  };
}

/** Drop UI-only fields before diffing or sending so clicking
 * "Change" doesn't count as a dirty edit, and an empty secret
 * doesn't show up as different from a saved one. Real config
 * fields (smtp_host, smtp_port, smtp_user, smtp_from, smtp_use_tls)
 * are always included so changes to them register. */
function stripLocalOnly(p: Preferences): unknown {
  const channels: Record<string, unknown> = {};
  for (const c of ALL_CHANNELS) {
    const cfg = p.channels[c];
    const trimmed: Record<string, unknown> = {
      enabled: cfg.enabled,
      target: cfg.target,
      categories: cfg.categories,
      severity_min: cfg.severity_min,
    };
    if (cfg.bot_token && cfg.bot_token.trim()) {
      trimmed.bot_token = cfg.bot_token;
    }
    if (c === "EMAIL") {
      trimmed.smtp_host = cfg.smtp_host ?? "";
      trimmed.smtp_port = cfg.smtp_port ?? 587;
      trimmed.smtp_user = cfg.smtp_user ?? "";
      trimmed.smtp_from = cfg.smtp_from ?? "";
      trimmed.smtp_use_tls = cfg.smtp_use_tls ?? true;
      if (cfg.smtp_password && cfg.smtp_password.trim()) {
        trimmed.smtp_password = cfg.smtp_password;
      }
    }
    channels[c] = trimmed;
  }
  return { ...p, channels };
}

function errorMessage(e: unknown): string {
  if (!e) return "";
  const err = e as { response?: { data?: { detail?: string; message?: string } }; message?: string };
  return (
    err?.response?.data?.detail ||
    err?.response?.data?.message ||
    err?.message ||
    "Request failed"
  );
}

export function NotificationPreferencesPanel() {
  const { data, error, mutate, isLoading } = useSWR<Preferences>(
    "/notifications/preferences",
    fetcher,
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );
  const { data: channelStatus } = useSWR<Record<NotificationChannel, ChannelStatus>>(
    "/notifications/channels/status",
    fetcher,
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );
  const { data: emailProviders } = useSWR<{ providers: EmailProvider[] }>(
    "/notifications/channels/email/providers",
    fetcher,
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-channel test result (keyed by channel) — surfaced inline in
  // the channel row so the user sees pass/fail without a toast.
  const [testResult, setTestResult] = useState<
    Partial<Record<NotificationChannel, { ok: boolean; error?: string | null; at: number }>>
  >({});
  // Telegram chat-ID auto-detect modal state.
  const [tgDiscover, setTgDiscover] = useState<{
    open: boolean;
    loading: boolean;
    chats: TelegramChat[];
    error: string | null;
  }>({ open: false, loading: false, chats: [], error: null });

  // Once the fetch resolves (success OR failure), seed the form. On
  // failure we fall back to defaults so the user can still configure
  // their preferences — Save will create the row server-side.
  useEffect(() => {
    if (isLoading) return;
    if (draft) return;
    if (data) {
      setDraft(normalizePreferences(data));
    } else if (error) {
      setDraft(defaultPreferences());
    }
  }, [data, error, isLoading, draft]);

  const dirty = useMemo(() => {
    if (!draft) return false;
    const baseline = data ? normalizePreferences(data) : defaultPreferences();
    // Compare without the local-only edit fields. `has_bot_token` is
    // a UI flag the user can toggle (via "Change") that doesn't itself
    // mean there's anything to save, and `bot_token` is only relevant
    // when it carries a new value.
    return JSON.stringify(stripLocalOnly(baseline)) !== JSON.stringify(stripLocalOnly(draft));
  }, [data, draft]);

  const patchChannel = useCallback(
    (ch: NotificationChannel, p: Partial<ChannelConfig>) => {
      setDraft((d) =>
        d
          ? {
              ...d,
              channels: {
                ...d.channels,
                [ch]: { ...d.channels[ch], ...p },
              },
            }
          : d,
      );
    },
    [],
  );

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { data: updated } = await api.put<Preferences>(
        "/notifications/preferences",
        draft,
      );
      const normalized = normalizePreferences(updated);
      await mutate(normalized, false);
      setDraft(normalized);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  /** Fire a real direct test through the given channel + target. The
   * backend bypasses preference routing for this call so the user sees
   * the channel itself work / fail without first saving. For Telegram
   * we pass the freshly-typed token inline (if any) so the user can
   * verify it before committing. */
  async function sendChannelTest(ch: NotificationChannel, target: string) {
    setTestResult((r) => ({ ...r, [ch]: { ok: false, error: "...", at: 0 } }));
    const params: Record<string, string | number | boolean> = {
      channel: ch, target, severity: "INFO",
    };
    if (ch === "TELEGRAM" && draft?.channels.TELEGRAM.bot_token) {
      params.bot_token = draft.channels.TELEGRAM.bot_token;
    }
    if (ch === "EMAIL" && draft) {
      const e = draft.channels.EMAIL;
      // Only override server-side prefs if the user is mid-typing
      // (any non-empty SMTP field OR a fresh password). Otherwise we
      // fall back to whatever they last saved.
      const usingInline =
        !!(e.smtp_host || e.smtp_user || e.smtp_password);
      if (usingInline) {
        params.smtp_host = e.smtp_host ?? "";
        params.smtp_port = e.smtp_port ?? 587;
        params.smtp_user = e.smtp_user ?? "";
        params.smtp_password = e.smtp_password ?? "";
        params.smtp_from = e.smtp_from ?? "";
        params.smtp_use_tls = e.smtp_use_tls ?? true;
      }
    }
    try {
      const { data } = await api.post<{ ok: boolean; error?: string | null }>(
        `/notifications/channels/test`,
        null,
        { params },
      );
      setTestResult((r) => ({
        ...r,
        [ch]: { ok: !!data.ok, error: data.error || null, at: Date.now() },
      }));
    } catch (e) {
      setTestResult((r) => ({
        ...r,
        [ch]: { ok: false, error: errorMessage(e), at: Date.now() },
      }));
    }
  }

  /** One-click preset: fill in host / port / TLS for a well-known
   * provider so the user only types their email + app password.
   * Leaves user-typed username untouched if already set. */
  function applyEmailProvider(p: EmailProvider) {
    if (!draft) return;
    const cur = draft.channels.EMAIL;
    patchChannel("EMAIL", {
      smtp_host: p.host,
      smtp_port: p.port,
      smtp_use_tls: p.use_tls,
      // Don't blow away an existing username — the user may have
      // typed it before picking a preset.
      smtp_user: cur.smtp_user || cur.smtp_user || "",
    });
  }

  /** Connection-only verify (no message sent) — used by the "Verify"
   * button next to the SMTP fields. */
  async function verifyEmail() {
    if (!draft) return;
    const e = draft.channels.EMAIL;
    setTestResult((r) => ({ ...r, EMAIL: { ok: false, error: "...", at: 0 } }));
    try {
      const { data } = await api.post<{ ok: boolean; error?: string | null; server?: string | null }>(
        `/notifications/channels/email/verify`,
        null,
        {
          params: {
            smtp_host: e.smtp_host ?? "",
            smtp_port: e.smtp_port ?? 587,
            smtp_user: e.smtp_user ?? "",
            smtp_password: e.smtp_password ?? "",
            smtp_use_tls: e.smtp_use_tls ?? true,
          },
        },
      );
      setTestResult((r) => ({
        ...r,
        EMAIL: {
          ok: !!data.ok,
          error: data.ok
            ? (data.server ? `Connected to ${data.server}` : "Connected.")
            : (data.error || "verify failed"),
          at: Date.now(),
        },
      }));
    } catch (e2) {
      setTestResult((r) => ({
        ...r,
        EMAIL: { ok: false, error: errorMessage(e2), at: Date.now() },
      }));
    }
  }

  /** Fetch recent chats from the Telegram bot's `getUpdates` so the
   * user can pick their chat ID without leaving the app. Sends the
   * unsaved token inline when present so the user can auto-detect
   * without first saving. */
  async function discoverTelegram() {
    setTgDiscover({ open: true, loading: true, chats: [], error: null });
    const params: Record<string, string> = {};
    if (draft?.channels.TELEGRAM.bot_token) {
      params.bot_token = draft.channels.TELEGRAM.bot_token;
    }
    try {
      const { data } = await api.get<{
        ok: boolean;
        chats?: TelegramChat[];
        error?: string;
      }>(`/notifications/channels/telegram/discover`, { params });
      if (!data.ok) {
        setTgDiscover({
          open: true, loading: false, chats: [],
          error: data.error || "no chats found",
        });
      } else {
        setTgDiscover({
          open: true, loading: false,
          chats: data.chats || [], error: null,
        });
      }
    } catch (e) {
      setTgDiscover({
        open: true, loading: false, chats: [],
        error: errorMessage(e),
      });
    }
  }

  async function resetDefaults() {
    if (!confirm("Reset notification preferences to defaults?")) return;
    try {
      const { data: reset } = await api.post<Preferences>(
        "/notifications/preferences/reset",
      );
      const normalized = normalizePreferences(reset);
      await mutate(normalized, false);
      setDraft(normalized);
    } catch (e) {
      setSaveError(errorMessage(e));
    }
  }

  // Only show the spinner while we're actively waiting for the first
  // response. As soon as it resolves (success or error), the draft is
  // seeded from data or defaults and the form renders.
  if (isLoading && !draft) {
    return (
      <div className="card flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading notification preferences...
      </div>
    );
  }

  if (!draft) {
    // Defensive: would only hit if effect hasn't run yet for some reason.
    return null;
  }

  const loadError = !data && error ? errorMessage(error) : null;

  return (
    <div className="space-y-6">
      {(loadError || saveError) && (
        <div className="card border-loss/40 bg-loss/5 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-loss mt-0.5 shrink-0" />
          <div className="flex-1 text-xs">
            <div className="font-semibold text-loss mb-0.5">
              {loadError ? "Could not load preferences" : "Could not save preferences"}
            </div>
            <div className="text-muted-foreground break-words">
              {loadError || saveError}
            </div>
            {loadError && (
              <p className="text-muted-foreground mt-1.5">
                Showing defaults — fill in your channels and hit Save. If the error
                mentions <code className="font-mono">notification_preferences</code>{" "}
                or <code className="font-mono">notification_deliveries</code>, the
                database migration hasn&apos;t been applied yet — run{" "}
                <code className="font-mono">alembic upgrade head</code> in the backend.
              </p>
            )}
          </div>
          <button
            onClick={() => mutate()}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <RotateCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {/* ------ External channels ------ */}
      <div className="card">
        <header className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Bell className="w-4 h-4" /> Notification channels
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Route specific severities and categories to email, Telegram, Discord, or a custom
              webhook. The bell-dropdown (in-app) always works.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={resetDefaults} className="text-xs text-muted-foreground hover:text-loss underline">
              Reset defaults
            </button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className={cn(
                "text-xs px-3 py-1.5 rounded font-semibold inline-flex items-center gap-1.5",
                dirty
                  ? "bg-primary text-primary-foreground hover:opacity-90"
                  : "bg-muted text-muted-foreground cursor-not-allowed",
              )}
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Save
            </button>
            {savedAt && Date.now() - savedAt < 2000 && (
              <span className="inline-flex items-center gap-1 text-[10px] text-profit font-mono">
                <Check className="w-3 h-3" /> Saved
              </span>
            )}
          </div>
        </header>

        <div className="space-y-3">
          {EXTERNAL_CHANNELS.map(({ ch, label, targetLabel, targetHint }) => {
            const cfg = draft.channels[ch];
            const status = channelStatus?.[ch];
            const test = testResult[ch];
            return (
              <div
                key={ch}
                className={cn(
                  "border border-border/60 rounded-md p-3 space-y-2",
                  cfg.enabled && "bg-muted/30",
                )}
              >
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cfg.enabled}
                      onChange={(e) => patchChannel(ch, { enabled: e.target.checked })}
                    />
                    {label}
                    {status && (
                      <span
                        title={status.detail}
                        className={cn(
                          "inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded border",
                          status.configured
                            ? "bg-profit/15 text-profit border-profit/40"
                            : "bg-warning/15 text-warning border-warning/40",
                        )}
                      >
                        {status.configured ? (
                          <>
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            {ch === "TELEGRAM" && status.bot_username
                              ? `@${status.bot_username}`
                              : "Configured"}
                          </>
                        ) : (
                          <>
                            <AlertCircle className="w-2.5 h-2.5" /> Not configured
                          </>
                        )}
                      </span>
                    )}
                  </label>
                  <button
                    onClick={() => sendChannelTest(ch, cfg.target)}
                    disabled={!cfg.target}
                    className={cn(
                      "text-[10px] font-mono inline-flex items-center gap-1",
                      cfg.target
                        ? "text-muted-foreground hover:text-primary"
                        : "text-muted-foreground/50 cursor-not-allowed",
                    )}
                    title={cfg.target ? "Send test message" : "Enter a target first"}
                  >
                    <Send className="w-3 h-3" /> Test
                  </button>
                </div>

                {/* Per-channel test result strip */}
                {test && test.at > 0 && (
                  <div
                    className={cn(
                      "text-[10px] font-mono px-2 py-1 rounded border inline-flex items-start gap-1.5",
                      test.ok
                        ? "bg-profit/10 text-profit border-profit/30"
                        : "bg-loss/10 text-loss border-loss/30",
                    )}
                  >
                    {test.ok ? (
                      <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    )}
                    <span>
                      {test.ok
                        ? "Test message sent. Check your channel."
                        : `Failed: ${test.error || "unknown error"}`}
                    </span>
                  </div>
                )}

                {/* Telegram-only: per-user bot token (BotFather output).
                    The platform never holds a shared token — each user
                    runs their own bot. */}
                {ch === "TELEGRAM" && cfg.enabled && (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          Bot token
                          <span className="ml-1 normal-case tracking-normal text-muted-foreground/80">
                            (from @BotFather)
                          </span>
                        </label>
                        {cfg.has_bot_token && !cfg.bot_token && (
                          <span className="text-[10px] font-mono inline-flex items-center gap-1 text-profit">
                            <CheckCircle2 className="w-3 h-3" /> Token saved
                          </span>
                        )}
                      </div>
                      {cfg.has_bot_token && !cfg.bot_token ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value="••••••••••••••••••••"
                            disabled
                            className="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-muted/40 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              // Flip the local "Token saved" UI off so the
                              // input re-appears. The encrypted server-side
                              // value isn't cleared until the user types a
                              // new one and saves — empty stays preserve.
                              patchChannel("TELEGRAM", { has_bot_token: false })
                            }
                            className="text-[10px] font-mono px-2 py-1.5 rounded border border-border hover:bg-accent"
                          >
                            Change
                          </button>
                        </div>
                      ) : (
                        <input
                          type="password"
                          autoComplete="off"
                          value={cfg.bot_token || ""}
                          onChange={(e) =>
                            patchChannel("TELEGRAM", {
                              bot_token: e.target.value,
                            })
                          }
                          placeholder="123456789:AAH...BotFather token..."
                          className="w-full text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                        />
                      )}
                      <p className="text-[10px] text-muted-foreground">
                        Open Telegram → message{" "}
                        <a
                          href="https://t.me/BotFather"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline"
                        >
                          @BotFather
                        </a>{" "}
                        → <code>/newbot</code> → follow the prompts → paste the token here →
                        Save. Then click <em>Auto-detect</em> after sending <code>/start</code> to your bot.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {status?.deep_link && (
                        <a
                          href={status.deep_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-accent"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Open @{status.bot_username} & send /start
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={discoverTelegram}
                        disabled={!cfg.bot_token && !cfg.has_bot_token}
                        className={cn(
                          "text-[10px] font-mono inline-flex items-center gap-1 px-2 py-1 rounded border",
                          cfg.bot_token || cfg.has_bot_token
                            ? "border-primary/40 text-primary hover:bg-primary/10"
                            : "border-border text-muted-foreground/60 cursor-not-allowed",
                        )}
                        title={
                          cfg.bot_token || cfg.has_bot_token
                            ? "Read recent /start messages and auto-fill the chat ID"
                            : "Paste a bot token first"
                        }
                      >
                        <Zap className="w-3 h-3" /> Auto-detect chat ID
                      </button>
                    </div>
                  </>
                )}

                {/* Email-only: per-user SMTP settings (Gmail App
                    Password, SendGrid, corporate SMTP, etc.). One-
                    click provider preset fills host/port/TLS so the
                    user only types email + password. */}
                {ch === "EMAIL" && cfg.enabled && (
                  <div className="space-y-2 border-t border-border/40 pt-2">
                    {emailProviders?.providers && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          Provider
                        </label>
                        <select
                          value={
                            emailProviders.providers.find(
                              (p) =>
                                p.host === cfg.smtp_host &&
                                p.port === (cfg.smtp_port ?? 587),
                            )?.key || "custom"
                          }
                          onChange={(e) => {
                            const p = emailProviders.providers.find(
                              (x) => x.key === e.target.value,
                            );
                            if (p) applyEmailProvider(p);
                          }}
                          className="text-xs px-2 py-1 rounded border border-border bg-background"
                        >
                          {emailProviders.providers.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-8">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          SMTP host
                        </label>
                        <input
                          type="text"
                          value={cfg.smtp_host ?? ""}
                          onChange={(e) =>
                            patchChannel("EMAIL", { smtp_host: e.target.value })
                          }
                          placeholder="smtp.gmail.com"
                          className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          Port
                        </label>
                        <input
                          type="number"
                          value={cfg.smtp_port ?? 587}
                          onChange={(e) =>
                            patchChannel("EMAIL", {
                              smtp_port: Number(e.target.value),
                            })
                          }
                          className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                        />
                      </div>
                      <div className="col-span-2 flex items-end pb-1">
                        <label className="text-[10px] font-mono inline-flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfg.smtp_use_tls ?? true}
                            onChange={(e) =>
                              patchChannel("EMAIL", {
                                smtp_use_tls: e.target.checked,
                              })
                            }
                          />
                          TLS
                        </label>
                      </div>
                    </div>

                    <div>
                      <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        Username
                      </label>
                      <input
                        type="text"
                        autoComplete="off"
                        value={cfg.smtp_user ?? ""}
                        onChange={(e) =>
                          patchChannel("EMAIL", { smtp_user: e.target.value })
                        }
                        placeholder="you@gmail.com  (or `apikey` for SendGrid)"
                        className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          Password
                          <span className="ml-1 normal-case tracking-normal text-muted-foreground/80">
                            (App Password / API key)
                          </span>
                        </label>
                        {cfg.has_smtp_password && !cfg.smtp_password && (
                          <span className="text-[10px] font-mono inline-flex items-center gap-1 text-profit">
                            <CheckCircle2 className="w-3 h-3" /> Password saved
                          </span>
                        )}
                      </div>
                      {cfg.has_smtp_password && !cfg.smtp_password ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value="••••••••••••••••"
                            disabled
                            className="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-muted/40 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              // Flip local "saved" indicator off so the
                              // real input re-renders. The encrypted
                              // server-side value isn't replaced until
                              // the user actually types + saves.
                              patchChannel("EMAIL", { has_smtp_password: false })
                            }
                            className="text-[10px] font-mono px-2 py-1.5 rounded border border-border hover:bg-accent"
                          >
                            Change
                          </button>
                        </div>
                      ) : (
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={cfg.smtp_password ?? ""}
                          onChange={(e) =>
                            patchChannel("EMAIL", {
                              smtp_password: e.target.value,
                            })
                          }
                          placeholder="App password (Gmail: 16 chars, no spaces)"
                          className="w-full text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                        />
                      )}
                    </div>

                    <div>
                      <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        From (optional)
                      </label>
                      <input
                        type="text"
                        value={cfg.smtp_from ?? ""}
                        onChange={(e) =>
                          patchChannel("EMAIL", { smtp_from: e.target.value })
                        }
                        placeholder="Defaults to your username"
                        className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={verifyEmail}
                        disabled={
                          !cfg.smtp_host || !cfg.smtp_user ||
                          !(cfg.smtp_password || cfg.has_smtp_password)
                        }
                        className={cn(
                          "text-[10px] font-mono inline-flex items-center gap-1 px-2 py-1 rounded border",
                          cfg.smtp_host && cfg.smtp_user &&
                            (cfg.smtp_password || cfg.has_smtp_password)
                            ? "border-primary/40 text-primary hover:bg-primary/10"
                            : "border-border text-muted-foreground/60 cursor-not-allowed",
                        )}
                        title="Connect + authenticate without sending mail"
                      >
                        <Zap className="w-3 h-3" /> Verify connection
                      </button>
                      {(() => {
                        // Surface provider-specific hint + the
                        // App-Password URL beneath the form so the
                        // user knows exactly where to grab the
                        // credential.
                        const matched = emailProviders?.providers.find(
                          (p) =>
                            p.host === cfg.smtp_host &&
                            p.port === (cfg.smtp_port ?? 587),
                        );
                        if (!matched) return null;
                        return (
                          <span className="text-[10px] text-muted-foreground">
                            {matched.hint}
                            {matched.app_password_url && (
                              <>
                                {" "}
                                <a
                                  href={matched.app_password_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary underline"
                                >
                                  Get App Password
                                </a>
                              </>
                            )}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                )}

                {cfg.enabled && (
                  <>
                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-7">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          {targetLabel}
                        </label>
                        <input
                          type="text"
                          value={cfg.target}
                          onChange={(e) => patchChannel(ch, { target: e.target.value })}
                          placeholder={targetHint}
                          className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
                        />
                      </div>
                      <div className="col-span-5">
                        <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                          Minimum severity
                        </label>
                        <select
                          value={cfg.severity_min}
                          onChange={(e) =>
                            patchChannel(ch, {
                              severity_min: e.target.value as NotificationSeverity,
                            })
                          }
                          className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
                        >
                          {SEVERITY_ORDER.map((s) => (
                            <option key={s} value={s}>
                              {s}+
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                        Categories (empty = all)
                      </label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {CATEGORIES.map((cat) => {
                          const on = cfg.categories.includes(cat);
                          return (
                            <button
                              key={cat}
                              type="button"
                              onClick={() =>
                                patchChannel(ch, {
                                  categories: on
                                    ? cfg.categories.filter((c) => c !== cat)
                                    : [...cfg.categories, cat],
                                })
                              }
                              className={cn(
                                "text-[9px] font-mono px-1.5 py-0.5 rounded border",
                                on
                                  ? "bg-primary/20 text-primary border-primary/40"
                                  : "border-border text-muted-foreground hover:bg-accent",
                              )}
                            >
                              {cat.replace("_", " ")}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ------ Silent mode + rate limit ------ */}
      <div className="card grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-2">Silent mode</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Suppress all non-CRITICAL notifications during these hours. CRITICAL alerts always
            punch through so you don&apos;t lose money silently.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.silent_mode.enabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  silent_mode: { ...draft.silent_mode, enabled: e.target.checked },
                })
              }
            />
            Enable silent mode
          </label>
          {draft.silent_mode.enabled && (
            <div className="grid grid-cols-3 gap-2 mt-2">
              <div>
                <label className="text-[10px] font-mono uppercase text-muted-foreground">From</label>
                <input
                  type="time"
                  value={draft.silent_mode.start}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      silent_mode: { ...draft.silent_mode, start: e.target.value },
                    })
                  }
                  className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase text-muted-foreground">To</label>
                <input
                  type="time"
                  value={draft.silent_mode.end}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      silent_mode: { ...draft.silent_mode, end: e.target.value },
                    })
                  }
                  className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono uppercase text-muted-foreground">Timezone</label>
                <input
                  type="text"
                  value={draft.silent_mode.tz}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      silent_mode: { ...draft.silent_mode, tz: e.target.value },
                    })
                  }
                  className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background font-mono"
                />
              </div>
            </div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Rate limit / anti-spam</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Hard caps on how many notifications you can receive per minute and per hour.
            Overflow drops with a single SYSTEM log line.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-mono uppercase text-muted-foreground">Per minute</label>
              <input
                type="number"
                min={0}
                value={draft.rate_limit.per_minute}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    rate_limit: { ...draft.rate_limit, per_minute: Number(e.target.value) },
                  })
                }
                className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono uppercase text-muted-foreground">Per hour</label>
              <input
                type="number"
                min={0}
                value={draft.rate_limit.per_hour}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    rate_limit: { ...draft.rate_limit, per_hour: Number(e.target.value) },
                  })
                }
                className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ------ Sound + browser push + expiry ------ */}
      <div className="card grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-2">Sound alerts</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Play an in-browser audio chime when a notification of this severity arrives.
          </p>
          <div className="space-y-1.5 text-sm">
            {(
              [
                ["critical", "CRITICAL"],
                ["error", "ERROR"],
                ["warning", "WARNING"],
                ["info", "INFO"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.sound[k]}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      sound: { ...draft.sound, [k]: e.target.checked },
                    })
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Browser push</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Show OS-level notifications. The first time you enable this, your browser will ask
            for permission.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.browser_push}
              onChange={async (e) => {
                if (e.target.checked) {
                  await requestBrowserPermission();
                }
                setDraft({ ...draft, browser_push: e.target.checked });
              }}
            />
            Enable browser push
          </label>
          <label className="flex items-center gap-2 text-sm mt-1.5">
            <input
              type="checkbox"
              checked={draft.desktop_push}
              onChange={(e) => setDraft({ ...draft, desktop_push: e.target.checked })}
            />
            Native desktop push (future)
          </label>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">History</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Notifications older than this are auto-deleted by the background sweeper.
          </p>
          <label className="text-[10px] font-mono uppercase text-muted-foreground">
            Auto-expiry (days)
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.auto_expiry_days}
            onChange={(e) =>
              setDraft({ ...draft, auto_expiry_days: Number(e.target.value) })
            }
            className="w-full mt-0.5 text-xs px-2 py-1.5 rounded border border-border bg-background"
          />
        </div>
      </div>

      {tgDiscover.open && (
        <TelegramChatPicker
          state={tgDiscover}
          onPick={(chatId) => {
            patchChannel("TELEGRAM", { target: chatId });
            setTgDiscover((s) => ({ ...s, open: false }));
          }}
          onClose={() => setTgDiscover((s) => ({ ...s, open: false }))}
          onRetry={discoverTelegram}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telegram chat-picker modal
// ---------------------------------------------------------------------------

function TelegramChatPicker({
  state,
  onPick,
  onClose,
  onRetry,
}: {
  state: { loading: boolean; chats: TelegramChat[]; error: string | null };
  onPick: (chatId: string) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card max-w-md w-[92vw] space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Pick your Telegram chat</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Recent messages to the bot. Click your name to fill in the chat ID. If you
          don&apos;t see yourself, open Telegram and send <code>/start</code> to the
          bot, then click Refresh.
        </p>
        {state.loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Polling Telegram...
          </div>
        )}
        {!state.loading && state.error && (
          <div className="border border-loss/40 bg-loss/5 rounded p-2 text-xs text-loss flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{state.error}</span>
          </div>
        )}
        {!state.loading && !state.error && state.chats.length === 0 && (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No recent messages. Send <code>/start</code> to the bot, then Refresh.
          </div>
        )}
        {!state.loading && state.chats.length > 0 && (
          <div className="space-y-1 max-h-72 overflow-auto">
            {state.chats.map((c) => (
              <button
                key={c.chat_id}
                onClick={() => onPick(c.chat_id)}
                className="w-full text-left border border-border rounded p-2 hover:bg-accent transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{c.name}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {c.chat_id}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    {c.username ? `@${c.username}` : c.type}
                  </span>
                  {c.last_message && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[60%]">
                      “{c.last_message}”
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onRetry}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-accent"
          >
            <RotateCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
