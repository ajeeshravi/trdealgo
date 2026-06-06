"use client";
/**
 * API client for the US trading platform backend (FastAPI).
 *
 * Talks to the backend described in backend/app/api/v1. JWT is stored in
 * localStorage; the request interceptor attaches it and a 401 bounces the
 * user to the login page. This is intentionally separate from the legacy
 * `src/lib/api.ts` (which targets a different backend).
 */
import axios from "axios";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const PREFIX = "/api/v1";

export const TOKEN_KEY = "us_access_token";
export const REFRESH_KEY = "us_refresh_token";
export const ACCOUNT_KEY = "us_selected_account";

export function getToken(): string | null {
  return typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
}

export function setTokens(access: string, refresh: string): void {
  localStorage.setItem(TOKEN_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export const usApi = axios.create({ baseURL: BASE + PREFIX, timeout: 20000 });

usApi.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

usApi.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401 && typeof window !== "undefined") {
      clearTokens();
      if (!window.location.pathname.startsWith("/us/login")) {
        window.location.href = "/us/login";
      }
    }
    return Promise.reject(error);
  },
);

/** SWR fetcher. */
export const fetcher = (url: string) => usApi.get(url).then((r) => r.data);

/** Extract a human-readable message from an axios error. */
export function apiError(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    return detail.reason ? `${detail.rule}: ${detail.reason}` : JSON.stringify(detail);
  }
  return e?.message || "Request failed";
}
