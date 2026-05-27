"use client";
import { Activity, Settings, Sun, Moon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/ThemeProvider";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NotificationPanel } from "@/components/NotificationPanel";

export function Header() {
  const { theme, toggle } = useTheme();
  const router = useRouter();

  return (
    <header className="border-b border-border/50 px-6 py-3 flex items-center justify-between bg-card/50 backdrop-blur-sm sticky top-0 z-40">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="md:hidden" />
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <Activity className="w-5 h-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-lg font-bold tracking-tight">AlgoTrade</h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Algorithmic Trading Platform</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={toggle}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          title={theme === "dark" ? "Switch to Light" : "Switch to Dark"}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <NotificationPanel />

        <button
          onClick={() => router.push("/preferences")}
          className="p-2 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Preferences"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
