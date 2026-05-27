/**
 * Date-picker logic for EOD pages.
 *
 * NSE publishes the EOD bhavcopy ~18:15–18:45 IST and the platform's
 * scheduler ingests at `eod_ingest_time` (default 19:30 IST). Until that
 * cutoff passes, today's row doesn't exist in the DB — so the date
 * picker should not let the user select "today" yet. After the cutoff,
 * today becomes the newest selectable date.
 *
 * All time math is done in IST regardless of the user's browser zone,
 * since NSE is the only timezone that matters here. We don't depend on
 * the user's `Date()` being in IST.
 */

const DEFAULT_CUTOFF_HHMM = "19:30";

/** Now, decomposed into IST wall-clock parts. Works from any browser zone. */
export function nowIST(): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    y:  Number(get("year")),
    m:  Number(get("month")),
    d:  Number(get("day")),
    hh: Number(get("hour")),
    mm: Number(get("minute")),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

/** `2026-05-14`. Strict UTC math to avoid any browser-zone drift. */
function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Step a (y,m,d) backwards by N days. UTC-safe; no browser-zone drift. */
function addDays(y: number, m: number, d: number, delta: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Day-of-week for a (y,m,d) tuple. 0=Sun … 6=Sat. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Latest date the user can legitimately query EOD data for.
 *
 * Rule, in order:
 *   1. Start from "today IST".
 *   2. If IST clock has NOT crossed the cutoff (default 19:30, or the
 *      `eod_ingest_time` you pass in), step back one day.
 *   3. Step back further over Sat/Sun until a weekday — NSE doesn't
 *      publish on weekends.
 *   4. Step back further over NSE trading holidays (passed in by the
 *      caller; supply the set from `GET /eod/holidays`).
 *
 * `holidays` is an optional Set of ISO `YYYY-MM-DD` strings — when
 * omitted, only weekends are skipped (back-compat with callers that
 * haven't been wired to the holiday endpoint yet).
 */
export function maxAvailableEodDateISO(
  cutoffHHMM: string = DEFAULT_CUTOFF_HHMM,
  holidays?: ReadonlySet<string>,
): string {
  const ist = nowIST();
  const [chh, cmm] = (cutoffHHMM || DEFAULT_CUTOFF_HHMM).split(":").map(Number);
  const beforeCutoff = ist.hh < chh || (ist.hh === chh && ist.mm < cmm);

  let { y, m, d } = ist;
  if (beforeCutoff) ({ y, m, d } = addDays(y, m, d, -1));

  // Step back over Sat/Sun and holidays. Cap the walk at 14 days to
  // avoid an infinite loop if the holiday list ever covers every day
  // (would only happen if someone bulk-uploads garbage).
  for (let i = 0; i < 14; i++) {
    const dw = dow(y, m, d);
    const iso = toISO(y, m, d);
    const isWeekend = dw === 0 || dw === 6;
    const isHoliday = holidays?.has(iso) ?? false;
    if (!isWeekend && !isHoliday) break;
    ({ y, m, d } = addDays(y, m, d, -1));
  }
  return toISO(y, m, d);
}

/** True if `iso` is a Sat/Sun or in the holiday set. Used by date inputs
 * with an `onChange` validator to reject holiday picks even though
 * `<input type=date>` itself has no holiday-disable mechanism. */
export function isNonTradingDay(iso: string, holidays?: ReadonlySet<string>): boolean {
  const [yy, mm, dd] = iso.split("-").map(Number);
  if (!yy || !mm || !dd) return false;
  const dw = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
  if (dw === 0 || dw === 6) return true;
  return holidays?.has(iso) ?? false;
}

/** Today's IST date as ISO — handy when you want the picker default to
 * snap to "today" once the cutoff passes. Equivalent to today's
 * `maxAvailableEodDateISO` after the cutoff but never steps back to
 * yesterday before it. */
export function todayISTISO(): string {
  const { y, m, d } = nowIST();
  return toISO(y, m, d);
}
