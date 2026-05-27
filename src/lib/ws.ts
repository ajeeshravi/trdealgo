"use client";

/**
 * Single multiplexed WebSocket connection to the backend.
 *
 *   const stream = getStream();
 *   const off = stream.subscribeTicks(["RELIANCE-EQ"], (t) => ...);
 *   stream.subscribeCandles("RELIANCE-EQ", "5m", (c) => ...);
 *   off();              // unsubscribe single handler
 *
 * Auto-reconnects with exponential backoff and resubscribes everything
 * after each reconnection.
 *
 * Auth: the access JWT lives in `localStorage["access_token"]` and is
 * rotated by the axios 401 interceptor. The stream re-reads it on every
 * connect attempt (NOT just on construction) so a rotation is picked up
 * by the next reconnect. On an auth-failure close from the backend
 * (code 4401, or any unclean close while we never reached onopen), we
 * call /auth/refresh to mint a fresh access token before reconnecting —
 * otherwise the stream would hammer the backend forever with the same
 * expired JWT and live ticks never reach the page.
 */

const apiBase = (process.env.NEXT_PUBLIC_API_BASE || "") + "/api/v1";
const wsBase = (process.env.NEXT_PUBLIC_WS_BASE || "ws://localhost:8000") + "/api/v1";

type TickHandler = (data: any) => void;
type CandleHandler = (data: any) => void;

interface Subs {
  ticks: Map<string, Set<TickHandler>>;
  candles: Map<string, Set<CandleHandler>>; // key = "symbol:tf"
}

/** Try to refresh the access token via the refresh endpoint. Returns the
 *  new access token on success, or null if no refresh is possible (no
 *  refresh token present, or the refresh itself failed). */
async function refreshAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const refresh = localStorage.getItem("refresh_token");
  if (!refresh) return null;
  try {
    const res = await fetch(`${apiBase}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;
    localStorage.setItem("access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
    return data.access_token;
  } catch {
    return null;
  }
}

export class Stream {
  private ws: WebSocket | null = null;
  private subs: Subs = { ticks: new Map(), candles: new Map() };
  private closed = false;
  private backoff = 500;
  /** True once a connection has reached `onopen` since the page loaded.
   *  A close *before* the first successful open is almost always an auth
   *  failure (handshake rejected), so we treat it as a refresh trigger. */
  private everOpened = false;
  /** Guards against firing N concurrent refresh calls from rapid
   *  reconnect attempts on the same expired token. */
  private refreshInFlight: Promise<string | null> | null = null;

  constructor() {
    this.connect();
  }

  private async connect() {
    if (this.closed) return;
    // Re-read the token from localStorage every attempt — the axios 401
    // interceptor refreshes it under our feet, and the OLD captured-once
    // pattern left the stream hammering the backend with an expired
    // JWT forever.
    const token = typeof window !== "undefined"
      ? localStorage.getItem("access_token")
      : null;
    const url = `${wsBase}/ws/stream?token=${encodeURIComponent(token || "")}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.everOpened = true;
      this.backoff = 500;
      const tickSyms = Array.from(this.subs.ticks.keys());
      if (tickSyms.length) this.send({ action: "subscribe", channel: "ticks", symbols: tickSyms });
      for (const key of this.subs.candles.keys()) {
        const [symbol, tf] = key.split(":");
        this.send({ action: "subscribe", channel: "candles", symbol, timeframe: tf });
      }
    };
    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === "tick") {
        const sym = msg.data?.s;
        const handlers = sym ? this.subs.ticks.get(sym) : null;
        handlers?.forEach((h) => h(msg.data));
      } else if (msg.type === "candle") {
        const handlers = this.subs.candles.get(msg.channel);
        handlers?.forEach((h) => h(msg.data));
      }
    };
    ws.onclose = async (ev) => {
      if (this.closed) return;
      // 4401 is the explicit "invalid token" close the backend sends.
      // We also assume any close that arrived *before* we ever opened
      // is an auth handshake failure — Windows uvicorn currently raises
      // an unhandled exception on a stale JWT instead of returning the
      // explicit code, so we can't only key on `ev.code === 4401`.
      const looksLikeAuthFailure = ev.code === 4401 || !opened;
      if (looksLikeAuthFailure) {
        if (!this.refreshInFlight) {
          this.refreshInFlight = refreshAccessToken().finally(() => {
            this.refreshInFlight = null;
          });
        }
        const newTok = await this.refreshInFlight;
        if (newTok === null && this.everOpened === false) {
          // No refresh token (logged out) or refresh failed — keep
          // backing off; user will land on /login via the axios
          // interceptor on the next REST call.
        }
      }
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
    ws.onerror = () => { /* close handler will retry */ };
  }

  /** Force the stream to drop its current connection and re-handshake
   *  with whatever token is in localStorage now. Call this after a
   *  successful login so the WS picks up the fresh JWT immediately
   *  instead of waiting for the next natural close. */
  reconnect() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  private send(payload: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  subscribeTicks(symbols: string[], handler: TickHandler): () => void {
    const newOnes: string[] = [];
    for (const s of symbols) {
      let set = this.subs.ticks.get(s);
      if (!set) { set = new Set(); this.subs.ticks.set(s, set); newOnes.push(s); }
      set.add(handler);
    }
    if (newOnes.length) this.send({ action: "subscribe", channel: "ticks", symbols: newOnes });
    return () => {
      const drop: string[] = [];
      for (const s of symbols) {
        const set = this.subs.ticks.get(s);
        if (!set) continue;
        set.delete(handler);
        if (set.size === 0) { this.subs.ticks.delete(s); drop.push(s); }
      }
      if (drop.length) this.send({ action: "unsubscribe", channel: "ticks", symbols: drop });
    };
  }

  subscribeCandles(symbol: string, timeframe: string, handler: CandleHandler): () => void {
    const key = `${symbol}:${timeframe}`;
    let set = this.subs.candles.get(key);
    if (!set) {
      set = new Set();
      this.subs.candles.set(key, set);
      this.send({ action: "subscribe", channel: "candles", symbol, timeframe });
    }
    set.add(handler);
    return () => {
      const cur = this.subs.candles.get(key);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) {
        this.subs.candles.delete(key);
        this.send({ action: "unsubscribe", channel: "candles", symbol, timeframe });
      }
    };
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

let _stream: Stream | null = null;
export function getStream(): Stream {
  if (typeof window === "undefined") {
    throw new Error("getStream() called on server");
  }
  if (!_stream) {
    _stream = new Stream();
  }
  return _stream;
}

// ---- Backwards-compatible helpers (use Stream instead in new code) ----
export function openTickStream(symbols: string[], onTick: (t: any) => void): WebSocket {
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const url = `${wsBase}/ws/ticks?symbols=${encodeURIComponent(symbols.join(","))}&token=${encodeURIComponent(token || "")}`;
  const ws = new WebSocket(url);
  ws.onmessage = (m) => { try { onTick(JSON.parse(m.data)); } catch {} };
  return ws;
}

export function openCandleStream(symbol: string, tf: string, onCandle: (c: any) => void): WebSocket {
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const url = `${wsBase}/ws/candles/${encodeURIComponent(symbol)}/${encodeURIComponent(tf)}?token=${encodeURIComponent(token || "")}`;
  const ws = new WebSocket(url);
  ws.onmessage = (m) => { try { onCandle(JSON.parse(m.data)); } catch {} };
  return ws;
}
