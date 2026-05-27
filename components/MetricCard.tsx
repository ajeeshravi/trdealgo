import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  trend?: "up" | "down" | "neutral";
  icon?: React.ReactNode;
}

export function MetricCard({ label, value, subValue, trend = "neutral", icon }: MetricCardProps) {
  return (
    <Card className={cn("border-border/50 glow-primary transition-all hover:border-primary/30")}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
          {icon && <span className="text-muted-foreground">{icon}</span>}
        </div>
        <div className="font-mono text-2xl font-bold tracking-tight">
          <span className={cn(trend === "up" && "text-profit", trend === "down" && "text-loss")}>
            {value}
          </span>
        </div>
        {subValue && (
          <div
            className={cn(
              "font-mono text-xs mt-1",
              trend === "up" && "text-profit",
              trend === "down" && "text-loss",
              trend === "neutral" && "text-muted-foreground",
            )}
          >
            {subValue}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
