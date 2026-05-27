import {
  LayoutDashboard,
  Eye,
  Grid3X3,
  ScanSearch,
  Hash,
  Radio,
  ListOrdered,
  Briefcase,
  Brain,
  Building2,
  History,
  LineChart,
  BarChart3,
  BookOpen,
  Newspaper,
  Plug,
  SlidersHorizontal,
  Shield,
  TrendingUp,
  CandlestickChart,
  Sparkles,
  UserCircle,
  Goal,
  Zap,
} from "lucide-react";

export type NavTab = {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
};

export type NavGroup = {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  /** Where the sidebar item navigates (first tab, or the page itself if no tabs). */
  defaultHref: string;
  /** If present, AppShell renders a tab strip when pathname is inside this group. */
  tabs?: NavTab[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    icon: LayoutDashboard,
    defaultHref: "/dashboard",
  },
  {
    id: "markets",
    title: "Markets",
    icon: CandlestickChart,
    defaultHref: "/watchlists",
    tabs: [
      { label: "Watchlists", href: "/watchlists", icon: Eye },
      { label: "Option Chain", href: "/option-chain", icon: Grid3X3 },
      { label: "Intraday Charts", href: "/intraday-charts", icon: LineChart },
      { label: "Screener", href: "/screener", icon: ScanSearch },
      { label: "Symbols", href: "/symbols", icon: Hash },
      { label: "Live Feed", href: "/feed", icon: Radio },
    ],
  },
  {
    id: "trade",
    title: "Trade",
    icon: TrendingUp,
    defaultHref: "/strategies",
    tabs: [
      { label: "Strategies", href: "/strategies", icon: Brain },
      { label: "Positions", href: "/positions", icon: Briefcase },
      { label: "Orders", href: "/orders", icon: ListOrdered },
      { label: "Triggers", href: "/triggers", icon: Zap },
      { label: "Backtests", href: "/backtests", icon: History },
    ],
  },
  {
    id: "insights",
    title: "Insights",
    icon: Sparkles,
    defaultHref: "/tomorrow-plan",
    tabs: [
      { label: "Tomorrow's Plan", href: "/tomorrow-plan", icon: Goal },
      { label: "Analytics", href: "/analytics", icon: LineChart },
      { label: "EOD Analysis", href: "/eod-analysis", icon: BarChart3 },
      { label: "Institutional", href: "/institutional", icon: Building2 },
      { label: "Trade Journal", href: "/trade-journal", icon: BookOpen },
      { label: "Corporate Announcements", href: "/market-news", icon: Newspaper },
    ],
  },
  {
    id: "account",
    title: "Account",
    icon: UserCircle,
    defaultHref: "/brokers",
    tabs: [
      { label: "Brokers", href: "/brokers", icon: Plug },
      { label: "Preferences", href: "/preferences", icon: SlidersHorizontal },
      { label: "Admin", href: "/admin", icon: Shield, adminOnly: true },
    ],
  },
];

/** Returns the group whose tabs include the given pathname, or null. */
export function findActiveGroup(pathname: string): NavGroup | null {
  for (const g of NAV_GROUPS) {
    if (g.tabs?.some((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))) return g;
    if (pathname === g.defaultHref || pathname.startsWith(`${g.defaultHref}/`)) return g;
  }
  return null;
}
