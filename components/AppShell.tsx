"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Header } from "@/components/Header";
import { GroupTabs } from "@/components/GroupTabs";
import { NAV_GROUPS, findActiveGroup } from "@/components/nav-groups";
import { useAuth } from "@/store/auth";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const activeGroup = findActiveGroup(pathname);
  const tabs = activeGroup?.tabs?.filter((t) => !t.adminOnly || isAdmin);

  // Pre-warm every sidebar destination + sibling tab so the user never
  // pays the dev-mode webpack-compile cost on click. In production this
  // is essentially free (Link prefetches in viewport on its own); in
  // `next dev` this is what makes nav feel smooth instead of the route
  // bundle compiling lazily on first click. Scheduled on requestIdleCallback
  // (fallback: setTimeout) so it doesn't block the initial paint of the
  // current route.
  useEffect(() => {
    const targets: string[] = [];
    for (const g of NAV_GROUPS) {
      if (g.adminOnly && !isAdmin) continue;
      targets.push(g.defaultHref);
      for (const t of g.tabs ?? []) {
        if (t.adminOnly && !isAdmin) continue;
        targets.push(t.href);
      }
    }
    const unique = Array.from(new Set(targets));
    const run = () => {
      for (const href of unique) {
        try { router.prefetch(href); } catch { /* ignore */ }
      }
    };
    const w = window as any;
    const handle = typeof w.requestIdleCallback === "function"
      ? w.requestIdleCallback(run, { timeout: 1500 })
      : window.setTimeout(run, 250);
    return () => {
      if (typeof w.cancelIdleCallback === "function") {
        try { w.cancelIdleCallback(handle); } catch { /* ignore */ }
      } else {
        clearTimeout(handle);
      }
    };
  }, [router, isAdmin]);

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 p-6 overflow-x-hidden">
          {tabs && tabs.length > 0 && <GroupTabs tabs={tabs} />}
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
