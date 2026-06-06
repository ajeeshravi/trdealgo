"use client";
/**
 * Shared broker-account selection across the US app. Loads the user's linked
 * broker accounts and tracks the active one (persisted in localStorage).
 */
import { createContext, useContext, useEffect, useState } from "react";
import useSWR from "swr";

import { ACCOUNT_KEY, fetcher } from "@/lib/us/api";

export interface BrokerAccount {
  id: string;
  broker: string;
  alias: string | null;
  paper: boolean;
  status: string;
}

interface AccountCtx {
  accounts: BrokerAccount[];
  selected: BrokerAccount | null;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  isLoading: boolean;
  refresh: () => void;
}

const Ctx = createContext<AccountCtx | null>(null);

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading, mutate } = useSWR<BrokerAccount[]>("/broker-accounts", fetcher);
  const [selectedId, setSelectedIdState] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(ACCOUNT_KEY);
    if (stored) setSelectedIdState(stored);
  }, []);

  useEffect(() => {
    // Default to the first account once loaded if nothing valid is selected.
    if (data && data.length && (!selectedId || !data.find((a) => a.id === selectedId))) {
      setSelectedIdState(data[0].id);
      localStorage.setItem(ACCOUNT_KEY, data[0].id);
    }
  }, [data, selectedId]);

  const setSelectedId = (id: string) => {
    setSelectedIdState(id);
    localStorage.setItem(ACCOUNT_KEY, id);
  };

  const accounts = data ?? [];
  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  return (
    <Ctx.Provider
      value={{ accounts, selected, selectedId, setSelectedId, isLoading, refresh: () => mutate() }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAccounts(): AccountCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAccounts must be used within AccountProvider");
  return ctx;
}
