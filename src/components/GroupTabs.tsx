"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export type GroupTab = {
  label: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
};

export function GroupTabs({ tabs }: { tabs: GroupTab[] }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  // Warm sibling tabs on hover/focus so dev-mode compile cost is paid
  // before the click — matches the prefetch-on-hover behaviour in NavLink.
  const warm = (href: string) => {
    try { router.prefetch(href); } catch { /* ignore */ }
  };
  return (
    <div className="border-b border-border/50 -mx-6 px-6 mb-6 overflow-x-auto">
      <nav className="flex gap-1 min-w-max">
        {tabs.map((t) => {
          const isActive = pathname === t.href || pathname.startsWith(`${t.href}/`);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              prefetch
              onMouseEnter={() => warm(t.href)}
              onFocus={() => warm(t.href)}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              {Icon && <Icon className="w-4 h-4" />}
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
