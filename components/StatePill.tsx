import { cn } from "@/lib/utils";

const STATE_STYLES: Record<string, string> = {
  NEW: "bg-secondary text-secondary-foreground",
  SENT: "bg-primary/20 text-primary",
  OPEN: "bg-warning/20 text-warning",
  PARTIAL: "bg-warning/20 text-warning",
  FILLED: "bg-profit/20 text-profit",
  CANCELLED: "bg-secondary text-secondary-foreground",
  REJECTED: "bg-loss/20 text-loss",
};

export function StatePill({ state }: { state: string }) {
  return (
    <span className={cn("pill font-mono", STATE_STYLES[state] || "bg-secondary text-secondary-foreground")}>
      {state}
    </span>
  );
}
