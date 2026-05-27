"use client";

/**
 * Notification types + live-feed plumbing for the centralised
 * Notification System.
 *
 * - {@link useNotificationFeed}: subscribes to the unified WS stream
 *   for real-time pushes, falls back to polling, owns the in-memory
 *   list, plays sounds, and surfaces a browser Notification when the
 *   user has granted permission.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationSeverity =
  | "INFO"
  | "SUCCESS"
  | "WARNING"
  | "ERROR"
  | "CRITICAL";

export type NotificationCategory =
  | "AUTH"
  | "BROKER"
  | "STRATEGY"
  | "SIGNAL"
  | "ORDER"
  | "TRADE"
  | "RISK"
  | "MARKET_DATA"
  | "SYSTEM"
  | "SCHEDULER"
  | "AUTOMATION"
  | "ADMIN";

export type NotificationChannel =
  | "IN_APP"
  | "EMAIL"
  | "TELEGRAM"
  | "DISCORD"
  | "WEBHOOK";

export type NotificationItem = {
  id: string;
  type: "info" | "profit" | "loss" | "warning";
  severity: NotificationSeverity;
  category: NotificationCategory;
  event: string;
  title: string;
  message: string;
  read: boolean;
  action_status?: string | null;
  strategy_id?: string | null;
  strategy_name?: string | null;
  broker_account_id?: string | null;
  broker_name?: string | null;
  account_label?: string | null;
  symbol?: string | null;
  order_id?: string | null;
  trade_id?: string | null;
  meta?: Record<string, unknown>;
  created_at: string;
  expires_at?: string | null;
  sound?: boolean;
  // Transient popup duration (seconds). 0 = no popup (bell only).
  // Driven by the event's spec default + admin override in the
  // Notification Settings panel.
  popup_seconds?: number;
};

export type NotificationListResponse = {
  items: NotificationItem[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
};

export type NotificationFilters = {
  unreadOnly?: boolean;
  severity?: NotificationSeverity;
  category?: NotificationCategory;
  strategyId?: string;
  brokerAccountId?: string;
  symbol?: string;
  search?: string;
};

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

export const SEVERITY_ORDER: NotificationSeverity[] = [
  "INFO",
  "SUCCESS",
  "WARNING",
  "ERROR",
  "CRITICAL",
];

export function severityClass(s: NotificationSeverity): string {
  switch (s) {
    case "SUCCESS":
      return "bg-profit/15 text-profit border-profit/40";
    case "WARNING":
      return "bg-warning/15 text-warning border-warning/40";
    case "ERROR":
      return "bg-loss/15 text-loss border-loss/40";
    case "CRITICAL":
      return "bg-loss/25 text-loss border-loss/60";
    case "INFO":
    default:
      return "bg-primary/15 text-primary border-primary/40";
  }
}

export function severityIcon(s: NotificationSeverity): string {
  return (
    {
      INFO: "i",
      SUCCESS: "+",
      WARNING: "!",
      ERROR: "x",
      CRITICAL: "!!",
    } as const
  )[s];
}

export function severityAtLeast(
  s: NotificationSeverity,
  min: NotificationSeverity,
): boolean {
  return SEVERITY_ORDER.indexOf(s) >= SEVERITY_ORDER.indexOf(min);
}

// ---------------------------------------------------------------------------
// Sound — lazily-built Web Audio bursts so we don't ship an mp3.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx) return audioCtx;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

export function playSound(severity: NotificationSeverity): void {
  const ctx = ensureAudio();
  if (!ctx) return;
  // Pick frequencies that read clearly across speakers without
  // being grating. CRITICAL gets a triple-tap.
  const pattern: { freq: number; durMs: number; gain: number }[] = (() => {
    if (severity === "CRITICAL")
      return [
        { freq: 880, durMs: 150, gain: 0.18 },
        { freq: 660, durMs: 150, gain: 0.18 },
        { freq: 880, durMs: 220, gain: 0.18 },
      ];
    if (severity === "ERROR")
      return [
        { freq: 660, durMs: 180, gain: 0.16 },
        { freq: 440, durMs: 220, gain: 0.16 },
      ];
    if (severity === "WARNING")
      return [{ freq: 740, durMs: 220, gain: 0.14 }];
    if (severity === "SUCCESS")
      return [{ freq: 980, durMs: 160, gain: 0.12 }];
    return [{ freq: 660, durMs: 120, gain: 0.1 }];
  })();
  let when = ctx.currentTime;
  for (const p of pattern) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = p.freq;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(p.gain, when + 0.01);
    gain.gain.linearRampToValueAtTime(0, when + p.durMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + p.durMs / 1000 + 0.02);
    when += p.durMs / 1000 + 0.05;
  }
}

// ---------------------------------------------------------------------------
// Browser push (Notification API)
// ---------------------------------------------------------------------------

export async function requestBrowserPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window))
    return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

function showBrowserPush(n: NotificationItem) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(`[${n.severity}] ${n.title}`, {
      body: n.message,
      tag: n.id,
      silent: true, // we play our own audio
    });
  } catch {
    // Some platforms (Linux + Brave) throw on construction — silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Live feed hook
// ---------------------------------------------------------------------------

const WS_BASE =
  (process.env.NEXT_PUBLIC_WS_BASE || "ws://localhost:8000") + "/api/v1";

type FeedOptions = {
  /** Page size for the initial fetch + infinite-scroll fetches. */
  pageSize?: number;
  /** Whether to play sounds for incoming pushes. Default `true`. */
  enableSound?: boolean;
  /** Whether to surface OS notifications. Default `true`. */
  enableBrowserPush?: boolean;
};

export function useNotificationFeed(
  filters: NotificationFilters = {},
  opts: FeedOptions = {},
) {
  const { pageSize = 25, enableSound = true, enableBrowserPush = true } = opts;
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the latest filters in a ref so the WS push handler doesn't
  // need to re-subscribe on every typed character of the search box.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const matchesFilters = useCallback(
    (n: NotificationItem) => {
      const f = filtersRef.current;
      if (f.unreadOnly && n.read) return false;
      if (f.severity && n.severity !== f.severity) return false;
      if (f.category && n.category !== f.category) return false;
      if (f.strategyId && n.strategy_id !== f.strategyId) return false;
      if (f.brokerAccountId && n.broker_account_id !== f.brokerAccountId)
        return false;
      if (f.symbol && n.symbol !== f.symbol) return false;
      if (f.search) {
        const needle = f.search.toLowerCase();
        const hay =
          (n.title || "") +
          " " +
          (n.message || "") +
          " " +
          (n.symbol || "");
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      return true;
    },
    [],
  );

  // ---- Initial / filter-change fetch -----------------------------------
  const fetchPage = useCallback(
    async (resetOffset = 0) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(pageSize));
        params.set("offset", String(resetOffset));
        if (filters.unreadOnly) params.set("unread_only", "true");
        if (filters.severity) params.set("severity", filters.severity);
        if (filters.category) params.set("category", filters.category);
        if (filters.strategyId) params.set("strategy_id", filters.strategyId);
        if (filters.brokerAccountId)
          params.set("broker_account_id", filters.brokerAccountId);
        if (filters.symbol) params.set("symbol", filters.symbol);
        if (filters.search) params.set("search", filters.search);
        const { data } = await api.get<NotificationListResponse>(
          `/notifications?${params.toString()}`,
        );
        if (resetOffset === 0) {
          setItems(data.items);
        } else {
          setItems((cur) => {
            const seen = new Set(cur.map((c) => c.id));
            return [...cur, ...data.items.filter((d) => !seen.has(d.id))];
          });
        }
        setTotal(data.total);
        setUnread(data.unread);
        setOffset(resetOffset + data.items.length);
      } catch (e) {
        setError(e instanceof Error ? e.message : "load failed");
      } finally {
        setLoading(false);
      }
    },
    [
      filters.brokerAccountId,
      filters.category,
      filters.search,
      filters.severity,
      filters.strategyId,
      filters.symbol,
      filters.unreadOnly,
      pageSize,
    ],
  );

  useEffect(() => {
    fetchPage(0);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (loading) return;
    if (offset >= total) return;
    fetchPage(offset);
  }, [fetchPage, loading, offset, total]);

  // ---- Real-time push via WebSocket ------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("access_token");
    if (!token) return;
    let ws: WebSocket | null = null;
    let backoff = 500;
    let closed = false;

    // Coalesce bursts of incoming notifications so a deploy event that
    // emits 20 messages in one tick triggers a single React re-render
    // instead of 20. Sound + browser push still fire per-message — the
    // user wants the audible cue, just not the layout thrash.
    let pendingQueue: NotificationItem[] = [];
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      if (pendingQueue.length === 0) return;
      const batch = pendingQueue;
      pendingQueue = [];
      const filteredBatch = batch.filter(matchesFilters);
      const newCount = batch.length;
      const newUnread = batch.filter((n) => !n.read).length;
      if (filteredBatch.length > 0) {
        setItems((cur) => {
          const seen = new Set(cur.map((c) => c.id));
          const adds = filteredBatch.filter((d) => !seen.has(d.id));
          return adds.length === 0 ? cur : [...adds, ...cur];
        });
      }
      if (newCount > 0) setTotal((t) => t + newCount);
      if (newUnread > 0) setUnread((u) => u + newUnread);
    };

    const onMessage = (raw: string) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { type?: string }).type !== "notification"
      )
        return;
      const data = (payload as { data: NotificationItem }).data;
      if (!data || !data.id) return;
      pendingQueue.push(data);
      if (flushTimer == null) {
        flushTimer = window.setTimeout(flush, 100);
      }
      if (enableSound && data.sound) playSound(data.severity);
      if (enableBrowserPush) showBrowserPush(data);
    };

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
      ws.onmessage = (m) => onMessage(m.data);
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
      if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignored */
      }
    };
  }, [enableBrowserPush, enableSound, matchesFilters]);

  // ---- Mutations -------------------------------------------------------
  const markRead = useCallback(async (id: string) => {
    setItems((cur) => cur.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api.post(`/notifications/${id}/read`);
    } catch {
      /* swallowed — list will reconcile on next reload */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((cur) => cur.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try {
      await api.post(`/notifications/read-all`);
    } catch {
      /* ignored */
    }
  }, []);

  const dismiss = useCallback(
    async (id: string) => {
      const removed = items.find((n) => n.id === id);
      setItems((cur) => cur.filter((n) => n.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      if (removed && !removed.read) setUnread((u) => Math.max(0, u - 1));
      try {
        await api.delete(`/notifications/${id}`);
      } catch {
        /* ignored */
      }
    },
    [items],
  );

  const clearAll = useCallback(async () => {
    setItems([]);
    setTotal(0);
    setUnread(0);
    try {
      await api.delete(`/notifications`);
    } catch {
      /* ignored */
    }
  }, []);

  const refresh = useCallback(() => fetchPage(0), [fetchPage]);

  return {
    items,
    total,
    unread,
    loading,
    error,
    hasMore: offset < total,
    loadMore,
    markRead,
    markAllRead,
    dismiss,
    clearAll,
    refresh,
  };
}
