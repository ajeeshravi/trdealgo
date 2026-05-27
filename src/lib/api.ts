"use client";
import axios, { AxiosInstance } from "axios";

const baseURL = (process.env.NEXT_PUBLIC_API_BASE || "") + "/api/v1";

export const api: AxiosInstance = axios.create({
  baseURL,
  headers: { "Content-Type": "application/json" },
  // 20s ceiling. Without this, a stalled backend (broker REST hang,
  // upstream NSE timeout) leaves SWR loading state pinned indefinitely
  // and queues every retry behind the dead request — feels like the UI
  // froze. 20s is generous for analytics/backtest endpoints while
  // surfacing snapshot/LTP hangs quickly enough to retry.
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("access_token");
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    if (err?.response?.status === 401 && typeof window !== "undefined") {
      const refresh = localStorage.getItem("refresh_token");
      if (refresh && !err.config._retried) {
        err.config._retried = true;
        try {
          const { data } = await axios.post(
            `${baseURL}/auth/refresh`,
            { refresh_token: refresh },
            // Short timeout for the refresh call itself — if the backend
            // is wedged, we want to fail fast and propagate the original
            // 401 (no token nuke; see catch below).
            { timeout: 8000 },
          );
          localStorage.setItem("access_token", data.access_token);
          localStorage.setItem("refresh_token", data.refresh_token);
          err.config.headers.Authorization = `Bearer ${data.access_token}`;
          return axios.request(err.config);
        } catch (refreshErr: any) {
          // Only log the user out when the refresh endpoint EXPLICITLY
          // rejects the refresh token (401 / 403). A timeout, 5xx, or
          // network error means the backend is sick — NOT that the
          // session is invalid. The earlier "any failure → logout"
          // behavior was kicking users out whenever a single endpoint
          // (slow DB query, pool saturation, broker REST hang) blocked
          // the event loop long enough for refresh to time out.
          const status = refreshErr?.response?.status;
          const isExplicitAuthFail = status === 401 || status === 403;
          if (isExplicitAuthFail) {
            localStorage.removeItem("access_token");
            localStorage.removeItem("refresh_token");
            if (window.location.pathname !== "/login") window.location.href = "/login";
          }
          // For non-auth failures, fall through and reject with the
          // ORIGINAL error so callers can show their own retry UI and
          // the session survives the backend hiccup.
        }
      }
    }
    return Promise.reject(err);
  },
);

export function bearerToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("access_token");
}
