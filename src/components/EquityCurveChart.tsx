"use client";
/**
 * Thin Recharts wrappers used by the dashboard's dialog charts.
 *
 * Bundled together (and dynamically imported by the dashboard) so the
 * Recharts library — ~120 KB minified — only lands on the user's
 * machine when they open a dialog that actually contains a chart,
 * instead of every time they navigate to /dashboard.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "8px",
  fontSize: "12px",
  fontFamily: "monospace",
};

interface EquityCurvePoint {
  day: string;
  equity: number;
}

interface VixPoint {
  d: string;
  close: number;
}

interface FlowPoint {
  d: string;
  fii: number;
  dii: number;
  net: number;
}

interface VariantProps {
  variant: "equity";
  data: EquityCurvePoint[];
}
interface VixProps {
  variant: "vix";
  data: VixPoint[];
}
interface FlowProps {
  variant: "fii_dii";
  data: FlowPoint[];
}

type Props = VariantProps | VixProps | FlowProps;

export default function EquityCurveChart(props: Props) {
  if (props.variant === "equity") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={props.data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            interval={4}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: number) => [`₹${value.toLocaleString("en-IN")}`, ""]}
          />
          <Line
            type="monotone"
            dataKey="equity"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={false}
            name="Portfolio"
          />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (props.variant === "vix") {
    const data = props.data;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
          <XAxis
            dataKey="d"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            interval={Math.max(0, Math.floor(data.length / 8) - 1)}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(v: number) => [v.toFixed(2), "VIX"]}
          />
          <Line
            type="monotone"
            dataKey="close"
            stroke="hsl(var(--warning))"
            strokeWidth={2}
            dot={false}
            name="VIX"
          />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const data = props.data;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
        <XAxis
          dataKey="d"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          interval={Math.max(0, Math.floor(data.length / 8) - 1)}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${v}`}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(v: number, name: string) => [`₹${v.toLocaleString("en-IN")} Cr`, name]}
        />
        <Line type="monotone" dataKey="fii" stroke="hsl(var(--loss))" strokeWidth={2} dot={false} name="FII Net" />
        <Line type="monotone" dataKey="dii" stroke="hsl(var(--profit))" strokeWidth={2} dot={false} name="DII Net" />
        <Line
          type="monotone"
          dataKey="net"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          dot={false}
          name="Combined Net"
          strokeDasharray="4 4"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
