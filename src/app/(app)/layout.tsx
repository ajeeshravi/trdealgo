"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AppShell } from "@/components/AppShell";
import { SWRProvider } from "@/components/SWRProvider";
import { NotificationPopupHost } from "@/components/NotificationPopupHost";
import { api } from "@/lib/api";
import { useAuth } from "@/store/auth";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, setUser } = useAuth();
  useEffect(() => {
    const t = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    if (!t) {
      router.replace("/login");
      return;
    }
    if (!user) {
      api.get("/auth/me").then((r) => setUser(r.data)).catch(() => router.replace("/login"));
    }
  }, [router, user, setUser]);

  return (
    <ThemeProvider>
      <SWRProvider>
        <ConfirmProvider>
          <AppShell>{children}</AppShell>
          {/* Transient on-screen popups for notifications whose admin
              setting specifies popup_seconds > 0. Bell-dropdown still
              receives everything regardless of popup duration. */}
          {user ? <NotificationPopupHost /> : null}
        </ConfirmProvider>
      </SWRProvider>
    </ThemeProvider>
  );
}
