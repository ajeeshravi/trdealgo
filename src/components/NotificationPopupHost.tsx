"use client";

/**
 * Transient on-screen popup host for the centralised notification
 * system.
 *
 * Mounted once at the AppShell level. Opens its own WebSocket to the
 * unified ``/ws/stream`` endpoint and surfaces an auto-dismissing
 * card for any notification whose ``popup_seconds`` is > 0.
 *
 * Why a second WS connection instead of piggy-backing on
 * ``useNotificationFeed``?
 *   - The feed hook is page-scoped (lives inside the bell-dropdown
 *     component, may unmount on navigation).
 *   - The popup host needs to live for the whole authenticated
 *     session.
 *   - WS connections are cheap; both subscribe to the same per-user
 *     Redis channel server-side, so each message arrives on both.
 *
 * Admin controls per-event popup duration via the Notification
 * Settings card on the Admin page. When the admin sets a duration of
 * 0, only the bell receives it; popup is suppressed here.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { NotificationItem } from "@/lib/notifications";
import { severityClass, severityIcon } from "@/lib/notifications";

const WS_BASE =
  (process.env.NEXT_PUBLIC_WS_BASE || "ws://localhost:8000") + "/api/v1";

type Popup = {
  // Unique key — server notification id, or a synthetic for the
  // (rare) case where the server omitted one. React reconciler hates
  // duplicate keys; a fallback timestamp keeps things sane.
  key: string;
  item: NotificationItem;
  // ms remaining when the popup mounted — used to drive a thin
  // progress bar so the user can see time bleeding out.
  durationMs: number;
};

/** Cap to keep the stack from running off-screen during a burst. */
const MAX_STACK = 5;

export function NotificationPopupHost() {
  const [popups, setPopups] = useState<Popup[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((key: string) => {
    setPopups((cur) => cur.filter((p) => p.key !== key));
    const t = timersRef.current.get(key);
    if (t != null) {
      window.clearTimeout(t);
      timersRef.current.delete(key);
    }
  }, []);

  const enqueue = useCallback(
    (item: NotificationItem) => {
      const seconds = Number(item.popup_seconds ?? 0);
      if (!seconds || seconds <= 0) return; // bell-only — admin/spec said no popup
      const key = item.id || `${Date.now()}-${Math.random()}`;
      const durationMs = Math.min(Math.max(seconds, 1), 60) * 1000;
      setPopups((cur) => {
        // Dedup: if this id is already on screen (rare WS replay),
        // skip rather than stack twice.
        if (cur.some((p) => p.key === key)) return cur;
        const next = [{ key, item, durationMs }, ...cur];
        return next.slice(0, MAX_STACK);
      });
      const handle = window.setTimeout(() => dismiss(key), durationMs);
      timersRef.current.set(key, handle);
    },
    [dismiss],
  );

  // ---- WS subscription ----------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("access_token");
    if (!token) return;
    let ws: WebSocket | null = null;
    let backoff = 500;
    let closed = false;

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
      if (!data) return;
      enqueue(data);
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
        window.setTimeout(connect, backoff);
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
      for (const t of timersRef.current.values()) window.clearTimeout(t);
      timersRef.current.clear();
    };
  }, [enqueue]);

  if (popups.length === 0) return null;

  return (
    <div
      className="fixed z-[60] top-4 right-4 flex flex-col gap-2 max-w-sm w-[22rem] pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {popups.map((p) => (
        <NotificationPopupCard
          key={p.key}
          popup={p}
          onClose={() => dismiss(p.key)}
        />
      ))}
    </div>
  );
}

function NotificationPopupCard({
  popup,
  onClose,
}: {
  popup: Popup;
  onClose: () => void;
}) {
  const { item, durationMs } = popup;
  // Drives the bottom-bar countdown. CSS transition handles the
  // animation; we just flip the width to 0 on next paint.
  const [progress, setProgress] = useState(100);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setProgress(0));
    return () => window.cancelAnimationFrame(id);
  }, []);

  return (
    <div
      role="status"
      className={`pointer-events-auto rounded-lg border shadow-lg backdrop-blur bg-card/95 ${severityClass(
        item.severity,
      )} overflow-hidden`}
    >
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <span
          className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs ${severityClass(
            item.severity,
          )}`}
          aria-hidden
        >
          {severityIcon(item.severity)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold truncate">{item.title}</div>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          {item.message && (
            <div className="mt-0.5 text-xs text-muted-foreground line-clamp-3 break-words">
              {item.message}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>{item.category}</span>
            {item.action_status && <span>· {item.action_status}</span>}
          </div>
        </div>
      </div>
      <div
        className="h-0.5 bg-current opacity-60"
        style={{
          width: `${progress}%`,
          transition: `width ${durationMs}ms linear`,
        }}
      />
    </div>
  );
}
