"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/store/auth";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/strategies", label: "Strategies" },
  { href: "/watchlists", label: "Watchlists" },
  { href: "/orders", label: "Orders" },
  { href: "/positions", label: "Positions" },
  { href: "/symbols", label: "Symbols" },
  { href: "/feed", label: "Live feed" },
  { href: "/backtests", label: "Backtests" },
  { href: "/analytics", label: "Analytics" },
  { href: "/settings", label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, clear } = useAuth();
  return (
    <aside className="w-56 shrink-0 border-r border-border bg-panel min-h-screen p-4 flex flex-col">
      <div className="mb-6">
        <div className="text-lg font-semibold">⚡ AlgoTrade</div>
        <div className="text-xs text-muted-foreground">Indian Markets</div>
      </div>
      <nav className="flex-1 space-y-1">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={clsx(
              "block rounded-md px-3 py-2 text-sm",
              pathname?.startsWith(n.href)
                ? "bg-panel2 text-white"
                : "text-gray-300 hover:bg-panel2",
            )}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="text-xs text-muted-foreground border-t border-border pt-3">
        {user?.email}
        <button
          className="block text-danger hover:underline mt-1"
          onClick={() => {
            clear();
            router.push("/login");
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
