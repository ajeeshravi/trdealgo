"use client";
import { useEffect, useMemo, useState } from "react";
import { Newspaper, ExternalLink, Search, FileText, Building2 } from "lucide-react";

import marketDataService from "@/services/marketDataService";
import type { NewsAnnouncement } from "@/lib/marketTypes";
import { Input } from "@/components/ui/input";

/**
 * Market News page — real NSE corporate-announcement feed.
 *
 * Source: `/market/announcements` (5-minute Redis cache server-side).
 * Click "Read more" / "Open on NSE" to navigate to the underlying
 * filing — we never re-host NSE attachments.
 */
export default function MarketNewsPage() {
  const [items, setItems] = useState<NewsAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const rows = await marketDataService.getNewsAnnouncements(100);
      if (!cancelled) {
        setItems(rows);
        setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (n) =>
        (n.symbol ?? "").toLowerCase().includes(q) ||
        (n.company_name ?? "").toLowerCase().includes(q) ||
        (n.industry ?? "").toLowerCase().includes(q) ||
        (n.subject ?? "").toLowerCase().includes(q) ||
        (n.attachment_text ?? n.description ?? "").toLowerCase().includes(q),
    );
  }, [items, search]);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Newspaper className="w-5 h-5 text-primary" />
            Corporate Announcements
          </h1>
          {/* <p className="text-sm text-muted-foreground">
            Live NSE corporate filings — click through to the official announcement
          </p> */}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Filter by symbol or subject..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 font-mono text-sm h-9"
          />
        </div>
      </header>

      {loading && items.length === 0 ? (
        <div className="card text-center py-10 text-muted-foreground font-mono text-sm">
          Loading announcements...
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-10 text-muted-foreground font-mono text-sm">
          {items.length === 0 ? "No announcements available right now." : "No matches for your filter."}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((n, i) => {
            const time = n.timestamp
              ? new Date(n.timestamp).toLocaleString("en-IN", {
                  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                })
              : "—";
            const subject = n.subject || n.description || "—";
            // Body precedence:
            //   1. description_full — XBRL-parsed rich text from the
            //      filing's XBRL XML. This is what NSE shows on its own
            //      site as the "Details" column.
            //   2. attachment_text — the inline text the filer typed
            //      alongside the PDF. Often empty or a dup of subject.
            // We skip rendering when the candidate equals the subject
            // (NSE often duplicates the headline as the body too).
            const rawBody =
              (n.description_full && n.description_full.trim()) ||
              (n.attachment_text && n.attachment_text.trim()) ||
              "";
            const body = rawBody && rawBody !== subject.trim() ? rawBody : "";
            return (
              <article
                key={`${n.symbol ?? "x"}-${i}`}
                className="card hover:border-primary/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {n.symbol && (
                      <span className="pill font-mono bg-primary/15 text-primary">{n.symbol}</span>
                    )}
                    {n.industry && (
                      <span
                        className="pill text-[10px] bg-panel2 text-muted-foreground"
                        title="Industry / sector"
                      >
                        {n.industry}
                      </span>
                    )}
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      NSE Corporate Filing
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground shrink-0">{time}</span>
                </div>
                <h3 className="font-semibold leading-snug">{subject}</h3>
                {n.company_name && (
                  <p
                    className="text-xs text-muted-foreground mt-0.5 truncate flex items-center gap-1"
                    title={n.company_name}
                  >
                    <Building2 className="w-3 h-3 shrink-0" />
                    {n.company_name}
                  </p>
                )}
                {body ? (
                  // Long XBRL descriptions (sometimes 2-3 paragraphs)
                  // collapse to 3 lines by default; <details> lets the
                  // user expand inline without leaving the page. The
                  // <summary> stays visible as the clamped preview.
                  <details className="group mt-2">
                    <summary
                      className="text-sm text-muted-foreground line-clamp-3 leading-relaxed cursor-pointer group-open:line-clamp-none marker:hidden list-none"
                      title={body}
                    >
                      {body}
                    </summary>
                  </details>
                ) : (
                  // Many NSE filings (especially "General Updates") have
                  // no inline body — the actual content lives only in
                  // the attached PDF. Surface a hint so the user knows
                  // why the card looks bare and where to find the
                  // details.
                  n.file_url && (
                    <p className="text-xs text-muted-foreground/70 italic mt-2">
                      Filer attached a PDF — open it for the announcement details.
                    </p>
                  )
                )}
                <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
                  <span className="text-xs font-mono text-muted-foreground">NSE</span>
                  <div className="flex items-center gap-2">
                    {n.file_url && (
                      <a
                        className="text-xs inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                        href={n.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={
                          n.file_size
                            ? `Open the attached PDF (${n.file_size})`
                            : "Open the attached PDF"
                        }
                      >
                        <FileText className="w-3.5 h-3.5" />
                        Open PDF
                        {n.file_size && (
                          <span className="text-[10px] font-mono opacity-70">
                            ({n.file_size})
                          </span>
                        )}
                      </a>
                    )}
                    {n.detail_url && (
                      <a
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                        href={n.detail_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Read more <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

