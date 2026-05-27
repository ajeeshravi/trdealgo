"use client";

/**
 * Centralised Notification Panel — the bell-dropdown that surfaces
 * every platform event in real time.
 *
 * Features:
 *   - real-time WS push (with poll fallback in {@link useNotificationFeed})
 *   - severity / category filters
 *   - free-text search
 *   - infinite scroll
 *   - mark single read / mark all / dismiss / clear all
 *   - sound alerts on CRITICAL / ERROR / WARNING (toggleable in prefs)
 *   - browser push (OS notification) when permission is granted
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Search, Trash2, X, Filter, Settings, Volume2, VolumeX } from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { prettyError, prettySymbol, fmtTs } from "@/lib/fmt";
import {
  NotificationCategory,
  NotificationFilters,
  NotificationItem,
  NotificationSeverity,
  requestBrowserPermission,
  severityClass,
  useNotificationFeed,
} from "@/lib/notifications";

const SEVERITY_OPTIONS: NotificationSeverity[] = [
  "INFO",
  "SUCCESS",
  "WARNING",
  "ERROR",
  "CRITICAL",
];

const CATEGORY_OPTIONS: NotificationCategory[] = [
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

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function NotificationPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<NotificationFilters>({});
  const [search, setSearch] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click. The earlier `fixed inset-0` backdrop relied
  // on covering the viewport, but the header's `backdrop-blur` creates a
  // containing block that clips the fixed element to the header — so the
  // backdrop never sat over the page body and outside clicks did nothing.
  // A document-level mousedown listener bypasses all stacking-context /
  // containing-block surprises.
  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent | TouchEvent) {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Debounce the search box so we don't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const mergedFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch || undefined }),
    [filters, debouncedSearch],
  );

  const {
    items,
    unread,
    total,
    loading,
    hasMore,
    loadMore,
    markRead,
    markAllRead,
    dismiss,
    clearAll,
  } = useNotificationFeed(mergedFilters, { enableSound: soundOn });

  // Ask for browser-push permission on first open.
  const askedPushRef = useRef(false);
  useEffect(() => {
    if (open && !askedPushRef.current) {
      askedPushRef.current = true;
      requestBrowserPermission().catch(() => null);
    }
  }, [open]);

  // Infinite scroll inside the dropdown.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) loadMore();
      },
      { rootMargin: "100px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [open, hasMore, loading, loadMore]);

  const activeFilterCount =
    (filters.severity ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (filters.unreadOnly ? 1 : 0);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((p) => !p)}
        className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground relative"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-loss text-[9px] font-bold text-destructive-foreground flex items-center justify-center">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
          <div className="absolute right-0 top-full mt-2 w-[420px] max-w-[95vw] rounded-lg border border-border bg-card shadow-xl z-50 overflow-hidden">
            {/* ----- header ----- */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">Notifications</span>
                {total > 0 && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {unread > 0 ? `${unread} unread / ` : ""}
                    {total} total
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setSoundOn((s) => !s)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  title={soundOn ? "Mute sound alerts" : "Enable sound alerts"}
                >
                  {soundOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => setShowFilters((p) => !p)}
                  className={cn(
                    "p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground relative",
                    showFilters && "bg-accent text-foreground",
                  )}
                  title="Filters"
                >
                  <Filter className="w-3.5 h-3.5" />
                  {activeFilterCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-3 h-3 px-0.5 rounded-full bg-primary text-[8px] text-primary-foreground flex items-center justify-center">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => {
                    setOpen(false);
                    router.push("/preferences#notifications");
                  }}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  title="Notification preferences"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* ----- search + actions ----- */}
            <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2">
              <div className="flex-1 relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search notifications..."
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {unread > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-[10px] font-mono text-primary hover:underline whitespace-nowrap"
                >
                  Mark all read
                </button>
              )}
              {total > 0 && (
                <button
                  onClick={clearAll}
                  className="text-[10px] font-mono text-muted-foreground hover:text-loss"
                  title="Clear all"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* ----- filter panel ----- */}
            {showFilters && (
              <div className="px-3 py-2 border-b border-border/40 space-y-2 bg-muted/30">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                    Severity:
                  </span>
                  {SEVERITY_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          severity: f.severity === s ? undefined : s,
                        }))
                      }
                      className={cn(
                        "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border",
                        filters.severity === s
                          ? severityClass(s)
                          : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                    Category:
                  </span>
                  {CATEGORY_OPTIONS.map((c) => (
                    <button
                      key={c}
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          category: f.category === c ? undefined : c,
                        }))
                      }
                      className={cn(
                        "text-[9px] font-mono px-1.5 py-0.5 rounded border",
                        filters.category === c
                          ? "bg-primary/20 text-primary border-primary/40"
                          : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {c.replace("_", " ")}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!filters.unreadOnly}
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        unreadOnly: e.target.checked || undefined,
                      }))
                    }
                  />
                  <span>Unread only</span>
                </label>
              </div>
            )}

            {/* ----- list ----- */}
            <div className="max-h-[520px] overflow-auto">
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-12">
                  {loading ? "Loading..." : "No notifications"}
                </p>
              ) : (
                <>
                  {items.map((n) => (
                    <NotificationRow
                      key={n.id}
                      n={n}
                      onMarkRead={() => !n.read && markRead(n.id)}
                      onDismiss={() => dismiss(n.id)}
                    />
                  ))}
                  <div ref={sentinelRef} className="h-px" />
                  {loading && (
                    <p className="text-[10px] text-muted-foreground text-center py-2 font-mono">
                      Loading...
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
      )}
    </div>
  );
}

const NotificationRow = memo(NotificationRowImpl, (prev, next) =>
  prev.n.id === next.n.id &&
  prev.n.read === next.n.read &&
  prev.n.title === next.n.title &&
  prev.n.message === next.n.message &&
  prev.n.severity === next.n.severity,
);

function NotificationRowImpl({
  n,
  onMarkRead,
  onDismiss,
}: {
  n: NotificationItem;
  onMarkRead: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      onClick={onMarkRead}
      className={cn(
        "px-4 py-3 border-b border-border/30 flex gap-3 items-start transition-colors",
        !n.read && "bg-accent/40 cursor-pointer hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "mt-1 w-2 h-2 rounded-full shrink-0",
          !n.read ? "bg-primary" : "bg-transparent",
        )}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={cn(
              "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border",
              severityClass(n.severity),
            )}
          >
            {n.severity}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground bg-muted/60 px-1 py-0.5 rounded">
            {n.category}
          </span>
          {n.action_status && (
            <span className="text-[9px] font-mono text-foreground/80 bg-muted px-1 py-0.5 rounded">
              {n.action_status}
            </span>
          )}
          <span
            className="text-[10px] text-muted-foreground font-mono ml-auto"
            title={fmtTs(n.created_at)}
          >
            {timeAgo(n.created_at)}
          </span>
        </div>
        <p className="text-xs font-semibold mt-1">{n.title}</p>
        {n.message && (
          <p className="text-[11px] text-muted-foreground mt-0.5 break-words">
            {prettyError(n.message)}
          </p>
        )}
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          {n.symbol && (
            <span className="text-[10px] font-mono text-foreground">
              {prettySymbol(n.symbol)}
            </span>
          )}
          {n.strategy_name && (
            <span className="text-[10px] font-mono text-muted-foreground">
              · {n.strategy_name}
            </span>
          )}
          {n.broker_name && (
            <span className="text-[10px] font-mono text-muted-foreground">
              · {n.broker_name}
            </span>
          )}
          {n.order_id && (
            <span className="text-[10px] font-mono text-muted-foreground">
              · ord {n.order_id.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
        aria-label="Dismiss notification"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
