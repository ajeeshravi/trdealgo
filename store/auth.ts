"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type User = { id: string; email: string; full_name?: string | null; role: string };

interface AuthState {
  user: User | null;
  setUser: (u: User | null) => void;
  setTokens: (a: string, r: string) => void;
  clear: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (u) => set({ user: u }),
      setTokens: (a, r) => {
        if (typeof window !== "undefined") {
          localStorage.setItem("access_token", a);
          localStorage.setItem("refresh_token", r);
        }
      },
      clear: () => {
        if (typeof window !== "undefined") {
          localStorage.removeItem("access_token");
          localStorage.removeItem("refresh_token");
        }
        set({ user: null });
      },
    }),
    { name: "auth", partialize: (s) => ({ user: s.user }) },
  ),
);
