"use client";
/**
 * US trading platform shell: auth guard, sidebar nav, broker-account selector.
 * Lives under /us so it never collides with the legacy app routes.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SWRConfig } from "swr";

import { AccountProvider, useAccounts } from "@/lib/us/account";
import { clearTokens, fetcher, getToken } from "@/lib/us/api";

const NAV = [
  { href: "/us/dashboard", label: "Dashboard" },
  { href: "/us/positions", label: "Positions" },
  { href: "/us/orders", label: "Orders" },
  { href: "/us/strategies", label: "Strategies" },
  { href: "/us/brokers", label: "Brokers" },
];

function AccountSelector() {
  const { accounts, selectedId, setSelectedId } = useAccounts();
  if (!accounts.length) {
    return (
      <Link href="/us/brokers" className="text-xs text-primary underline">
        Link a broker →
      </Link>
    );
  }
  return (
    <select
      value={selectedId ?? ""}
      onChange={(e) => setSelectedId(e.target.value)}
      className="rounded-md border bg-background px-2 py-1 text-sm"
    >
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.broker.toUpperCase()} {a.alias ? `(${a.alias})` : ""} · {a.paper ? "paper" : "live"}
        </option>
      ))}
    </select>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="w-56 shrink-0 border-r p-4">
        <div className="mb-6 text-lg font-bold">
          TradeAlgo <span className="text-xs font-normal text-muted-foreground">US</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-2 text-sm ${
                  active ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={() => {
            clearTokens();
            router.push("/us/login");
          }}
          className="mt-6 text-xs text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>
      </aside>
      <div className="flex-1">
        <header className="flex items-center justify-between border-b px-6 py-3">
          <div className="text-sm text-muted-foreground">US Stocks · ETFs · Options · Futures</div>
          <AccountSelector />
        </header>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}

export default function UsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const isLogin = pathname === "/us/login";

  useEffect(() => {
    if (isLogin) {
      setReady(true);
      return;
    }
    if (!getToken()) {
      router.replace("/us/login");
      return;
    }
    setReady(true);
  }, [isLogin, router]);

  if (!ready) return null;

  return (
    <SWRConfig value={{ fetcher, revalidateOnFocus: false }}>
      {isLogin ? children : <AccountProvider><Shell>{children}</Shell></AccountProvider>}
    </SWRConfig>
  );
}
