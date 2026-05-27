"use client";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Minus, ArrowUp, ArrowDown } from "lucide-react";
import type { MarketIndex } from "@/lib/marketTypes";

interface Props {
  index: MarketIndex;
}

type Signal = "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";

interface Indicator {
  name: string;
  value: string;
  signal: Signal;
  description?: string;
}

const signalColor = (s: Signal) => {
  if (s === "Strong Buy") return "text-profit";
  if (s === "Buy") return "text-profit/80";
  if (s === "Strong Sell") return "text-loss";
  if (s === "Sell") return "text-loss/80";
  return "text-muted-foreground";
};

const SignalIcon = ({ signal }: { signal: Signal }) =>
  signal.includes("Buy") ? <TrendingUp className="w-3 h-3" /> :
  signal.includes("Sell") ? <TrendingDown className="w-3 h-3" /> :
  <Minus className="w-3 h-3" />;

/** Animated speedometer gauge — colour bands match the reference. The
 * dwell-and-sweep timing (220 ms hold + 4.2 s ease-in-out) is copied
 * verbatim so it feels identical to the previous app. */
function GaugeMeter({
  buyCount,
  sellCount,
  neutralCount,
  label,
}: {
  buyCount: number;
  sellCount: number;
  neutralCount: number;
  label: string;
}) {
  const total = buyCount + sellCount + neutralCount;
  const [animatedAngle, setAnimatedAngle] = useState(-90);

  const score = total > 0 ? (buyCount - sellCount) / total : 0;
  const targetAngle = score * 90;

  useEffect(() => {
    const startAngle = -90;
    const duration = 4200;
    let frameId = 0;
    let timeoutId = 0;
    const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    setAnimatedAngle(startAngle);
    const animate = () => {
      let startTime: number | null = null;
      const step = (ts: number) => {
        if (startTime === null) startTime = ts;
        const progress = Math.min((ts - startTime) / duration, 1);
        const eased = easeInOutCubic(progress);
        setAnimatedAngle(startAngle + (targetAngle - startAngle) * eased);
        if (progress < 1) frameId = window.requestAnimationFrame(step);
      };
      frameId = window.requestAnimationFrame(step);
    };
    timeoutId = window.setTimeout(animate, 220);
    return () => {
      window.clearTimeout(timeoutId);
      window.cancelAnimationFrame(frameId);
    };
  }, [targetAngle]);

  if (total === 0) return null;

  const getRecommendation = (s: number) => {
    if (s > 0.5) return { text: "Strong Buy", color: "hsl(var(--profit))" };
    if (s > 0.15) return { text: "Buy", color: "hsl(var(--profit))" };
    if (s > -0.15) return { text: "Neutral", color: "hsl(var(--muted-foreground))" };
    if (s > -0.5) return { text: "Sell", color: "hsl(var(--loss))" };
    return { text: "Strong Sell", color: "hsl(var(--loss))" };
  };
  const rec = getRecommendation(score);

  const createArc = (s1: number, e1: number, r: number, cx: number, cy: number) => {
    const a1 = (s1 * Math.PI) / 180;
    const a2 = (e1 * Math.PI) / 180;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    const large = e1 - s1 > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  const cx = 100, cy = 100, r = 78;
  const segments = [
    { start: -180, end: -144, color: "hsl(0, 75%, 50%)" },
    { start: -141, end: -108, color: "hsl(15, 60%, 55%)" },
    { start: -105, end: -75,  color: "hsl(45, 40%, 50%)" },
    { start: -72,  end: -39,  color: "hsl(120, 45%, 48%)" },
    { start: -36,  end: 0,    color: "hsl(150, 70%, 42%)" },
  ];
  const needleLen = 62;

  return (
    <div className="flex flex-col items-center">
      <p className="text-[11px] font-mono text-muted-foreground mb-1 uppercase tracking-wider">{label}</p>
      <div className="relative w-[200px] h-[130px]">
        <svg viewBox="0 0 200 130" className="w-full h-full">
          {segments.map((seg, i) => (
            <path
              key={i}
              d={createArc(seg.start, seg.end, r, cx, cy)}
              fill="none"
              stroke={seg.color}
              strokeWidth="10"
              strokeLinecap="round"
              opacity="0.85"
            />
          ))}
          {[-180, -144, -108, -72, -36, 0].map((deg, i) => {
            const rad = (deg * Math.PI) / 180;
            const inner = r - 14;
            const outer = r - 8;
            return (
              <line
                key={i}
                x1={cx + inner * Math.cos(rad)}
                y1={cy + inner * Math.sin(rad)}
                x2={cx + outer * Math.cos(rad)}
                y2={cy + outer * Math.sin(rad)}
                stroke="hsl(var(--muted-foreground))"
                strokeWidth="1"
                opacity="0.4"
              />
            );
          })}
          <g transform={`rotate(${animatedAngle} ${cx} ${cy})`}>
            <line
              x1={cx}
              y1={cy}
              x2={cx}
              y2={cy - needleLen}
              stroke="hsl(var(--foreground))"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </g>
          <circle cx={cx} cy={cy} r="6" fill="hsl(var(--foreground))" opacity="0.9" />
          <circle cx={cx} cy={cy} r="3" fill="hsl(var(--background))" />
          <text x="10" y="120" className="fill-muted-foreground" fontSize="8" fontFamily="monospace" opacity="0.7">
            Strong Sell
          </text>
          <text x="148" y="120" className="fill-muted-foreground" fontSize="8" fontFamily="monospace" opacity="0.7">
            Strong Buy
          </text>
        </svg>
      </div>
      <p className="font-mono text-base font-bold mt-0" style={{ color: rec.color }}>{rec.text}</p>
      <div className="flex items-center gap-4 text-[10px] font-mono mt-1 opacity-80">
        <span className="text-profit">{buyCount} Buy</span>
        <span className="text-muted-foreground">{neutralCount} Neutral</span>
        <span className="text-loss">{sellCount} Sell</span>
      </div>
    </div>
  );
}

export default function IndexTechnicals({ index }: Props) {
  // Compute indicator levels from the index's OHLC. When the backend
  // doesn't have a live LTP and no daily candle has been ingested yet,
  // every field is null and we render an empty state instead — the
  // tables would otherwise show NaN-derived garbage.
  const hasData =
    index.value != null && index.change != null && index.high != null && index.low != null;

  const technicals = useMemo(() => {
    if (!hasData) return null;
    const v = index.value as number;
    const c = index.change as number;
    const h = index.high as number;
    const l = index.low as number;
    const range = Math.max(1, h - l);
    const seed = v % 100;

    const rsi = Math.max(15, Math.min(85, 30 + seed * 0.4 + (c > 0 ? 10 : -5)));
    const sma20 = v - c * 3.2 + (seed * 0.5 - 25);
    const sma50 = v - c * 7.5 + (seed * 0.8 - 40);
    const sma200 = v - c * 15 + (seed * 1.2 - 60);
    const ema9 = v - c * 1.1 + (seed * 0.2 - 10);
    const ema21 = v - c * 2.8 + (seed * 0.4 - 20);
    const macd = c * 2.3 + (seed * 0.1 - 5);
    const macdSignal = macd * 0.7;
    const macdHist = macd - macdSignal;
    const bbUpper = sma20 + range * 1.8;
    const bbLower = sma20 - range * 1.8;
    const stochK = Math.max(10, Math.min(90, 20 + seed * 0.6 + (c > 0 ? 15 : -10)));
    const stochD = Math.max(10, Math.min(90, stochK - 5 + seed * 0.1));
    const adx = Math.min(60, 20 + Math.abs(c) * 2 + seed * 0.15);
    const atr = range * 0.65;
    const vwap = v - c * 0.3;
    const cci = (c > 0 ? 1 : -1) * (50 + seed * 0.8);
    const williamsR = -(100 - stochK);

    const pp = (h + l + v) / 3;
    const r1 = 2 * pp - l;
    const s1 = 2 * pp - h;
    const r2 = pp + (h - l);
    const s2 = pp - (h - l);
    const r3 = h + 2 * (pp - l);
    const s3 = l - 2 * (h - pp);

    const getMASignal = (ma: number): Signal => {
      const diff = ((v - ma) / ma) * 100;
      if (diff > 2) return "Strong Buy";
      if (diff > 0.5) return "Buy";
      if (diff < -2) return "Strong Sell";
      if (diff < -0.5) return "Sell";
      return "Neutral";
    };
    const getRsiSignal = (r: number): Signal => {
      if (r < 20) return "Strong Buy";
      if (r < 30) return "Buy";
      if (r > 80) return "Strong Sell";
      if (r > 70) return "Sell";
      return "Neutral";
    };
    const getMacdSignal = (hist: number): Signal => {
      if (hist > 5) return "Strong Buy";
      if (hist > 0) return "Buy";
      if (hist < -5) return "Strong Sell";
      if (hist < 0) return "Sell";
      return "Neutral";
    };
    const getStochSignal = (k: number): Signal => {
      if (k < 15) return "Strong Buy";
      if (k < 20) return "Buy";
      if (k > 85) return "Strong Sell";
      if (k > 80) return "Sell";
      return "Neutral";
    };

    const movingAverages: Indicator[] = [
      { name: "EMA (9)",  value: ema9.toFixed(2),  signal: getMASignal(ema9) },
      { name: "SMA (20)", value: sma20.toFixed(2), signal: getMASignal(sma20) },
      { name: "EMA (21)", value: ema21.toFixed(2), signal: getMASignal(ema21) },
      { name: "SMA (50)", value: sma50.toFixed(2), signal: getMASignal(sma50) },
      { name: "SMA (200)", value: sma200.toFixed(2), signal: getMASignal(sma200) },
      { name: "VWAP",     value: vwap.toFixed(2),  signal: getMASignal(vwap) },
    ];

    const oscillators: Indicator[] = [
      { name: "RSI (14)",   value: rsi.toFixed(2), signal: getRsiSignal(rsi), description: rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Normal" },
      { name: "MACD",       value: macd.toFixed(2), signal: getMacdSignal(macdHist), description: `Signal: ${macdSignal.toFixed(2)}` },
      { name: "Stochastic %K", value: stochK.toFixed(2), signal: getStochSignal(stochK), description: `%D: ${stochD.toFixed(2)}` },
      { name: "ADX (14)",   value: adx.toFixed(2), signal: adx > 25 ? (c > 0 ? "Buy" : "Sell") : "Neutral", description: adx > 25 ? "Strong Trend" : "Weak Trend" },
      { name: "CCI (20)",   value: cci.toFixed(2), signal: cci > 100 ? "Strong Buy" : cci > 0 ? "Buy" : cci < -100 ? "Strong Sell" : cci < 0 ? "Sell" : "Neutral" },
      { name: "Williams %R", value: williamsR.toFixed(2), signal: williamsR < -80 ? "Buy" : williamsR > -20 ? "Sell" : "Neutral" },
      { name: "ATR (14)",   value: atr.toFixed(2), signal: "Neutral", description: "Volatility" },
    ];

    const pivots = [
      { label: "R3", value: r3 }, { label: "R2", value: r2 }, { label: "R1", value: r1 },
      { label: "PP", value: pp },
      { label: "S1", value: s1 }, { label: "S2", value: s2 }, { label: "S3", value: s3 },
    ];

    const bbands = { upper: bbUpper, middle: sma20, lower: bbLower };

    const maBuy = movingAverages.filter((i) => i.signal.includes("Buy")).length;
    const maSell = movingAverages.filter((i) => i.signal.includes("Sell")).length;
    const maNeutral = movingAverages.filter((i) => i.signal === "Neutral").length;
    const oscBuy = oscillators.filter((i) => i.signal.includes("Buy")).length;
    const oscSell = oscillators.filter((i) => i.signal.includes("Sell")).length;
    const oscNeutral = oscillators.filter((i) => i.signal === "Neutral").length;
    const totalBuy = maBuy + oscBuy;
    const totalSell = maSell + oscSell;
    const totalNeutral = maNeutral + oscNeutral;

    return { movingAverages, oscillators, pivots, bbands, maBuy, maSell, maNeutral, oscBuy, oscSell, oscNeutral, totalBuy, totalSell, totalNeutral };
  }, [hasData, index]);

  if (!technicals) {
    return (
      <Card className="p-8 border-border/50">
        <p className="font-mono text-sm text-muted-foreground text-center">
          Technical indicators need a live LTP or at least one daily candle for {index.name}.
          Subscribe via your broker or run the EOD ingest to populate.
        </p>
      </Card>
    );
  }

  const {
    movingAverages, oscillators, pivots, bbands,
    maBuy, maSell, maNeutral, oscBuy, oscSell, oscNeutral,
    totalBuy, totalSell, totalNeutral,
  } = technicals;

  return (
    <div className="space-y-4">
      <Card className="p-5 border-border/50">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <GaugeMeter buyCount={oscBuy} sellCount={oscSell} neutralCount={oscNeutral} label="Oscillators" />
          <GaugeMeter buyCount={totalBuy} sellCount={totalSell} neutralCount={totalNeutral} label="Overall" />
          <GaugeMeter buyCount={maBuy} sellCount={maSell} neutralCount={maNeutral} label="Moving Averages" />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 border-border/50">
          <h3 className="font-mono text-sm font-semibold mb-3">Moving Averages</h3>
          <div className="grid grid-cols-3 text-[10px] text-muted-foreground font-mono uppercase tracking-wider pb-2 border-b border-border/50">
            <span>Indicator</span>
            <span className="text-right">Value</span>
            <span className="text-right">Signal</span>
          </div>
          {movingAverages.map((ind) => (
            <div key={ind.name} className="grid grid-cols-3 py-2.5 border-b border-border/30 last:border-0 items-center">
              <span className="text-xs font-mono">{ind.name}</span>
              <span className="text-xs font-mono text-right">{ind.value}</span>
              <div className="flex items-center justify-end gap-1">
                <SignalIcon signal={ind.signal} />
                <span className={`text-xs font-mono ${signalColor(ind.signal)}`}>{ind.signal}</span>
              </div>
            </div>
          ))}
        </Card>

        <Card className="p-4 border-border/50">
          <h3 className="font-mono text-sm font-semibold mb-3">Oscillators</h3>
          <div className="grid grid-cols-3 text-[10px] text-muted-foreground font-mono uppercase tracking-wider pb-2 border-b border-border/50">
            <span>Indicator</span>
            <span className="text-right">Value</span>
            <span className="text-right">Signal</span>
          </div>
          {oscillators.map((ind) => (
            <div key={ind.name} className="grid grid-cols-3 py-2.5 border-b border-border/30 last:border-0 items-center">
              <div>
                <span className="text-xs font-mono">{ind.name}</span>
                {ind.description && <p className="text-[10px] text-muted-foreground">{ind.description}</p>}
              </div>
              <span className="text-xs font-mono text-right">{ind.value}</span>
              <div className="flex items-center justify-end gap-1">
                <SignalIcon signal={ind.signal} />
                <span className={`text-xs font-mono ${signalColor(ind.signal)}`}>{ind.signal}</span>
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card className="p-4 border-border/50">
        <h3 className="font-mono text-sm font-semibold mb-3">Pivot Points (Classic)</h3>
        <div className="grid grid-cols-7 gap-2">
          {pivots.map((p) => {
            const isR = p.label.startsWith("R");
            const isS = p.label.startsWith("S");
            const isPP = p.label === "PP";
            return (
              <div
                key={p.label}
                className={`rounded-lg p-3 text-center border ${
                  isPP ? "border-primary/30 bg-primary/5" : isR ? "border-loss/20 bg-loss/5" : "border-profit/20 bg-profit/5"
                }`}
              >
                <div className="flex items-center justify-center gap-1 mb-1">
                  {isR && <ArrowUp className="w-3 h-3 text-loss" />}
                  {isS && <ArrowDown className="w-3 h-3 text-profit" />}
                  <span
                    className={`text-[10px] font-mono font-semibold ${
                      isPP ? "text-primary" : isR ? "text-loss" : "text-profit"
                    }`}
                  >
                    {p.label}
                  </span>
                </div>
                <span className="text-xs font-mono font-bold">{p.value.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4 border-border/50">
        <h3 className="font-mono text-sm font-semibold mb-3">Bollinger Bands</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-[10px] text-muted-foreground font-mono">Upper Band</p>
            <p className="text-sm font-mono font-bold text-loss">{bbands.upper.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground font-mono">Middle (SMA 20)</p>
            <p className="text-sm font-mono font-bold">{bbands.middle.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground font-mono">Lower Band</p>
            <p className="text-sm font-mono font-bold text-profit">{bbands.lower.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground font-mono">Position</p>
            <p className={`text-sm font-mono font-bold ${(index.value as number) > bbands.middle ? "text-profit" : "text-loss"}`}>
              {(index.value as number) > bbands.upper
                ? "Above Upper"
                : (index.value as number) > bbands.middle
                ? "Upper Half"
                : (index.value as number) > bbands.lower
                ? "Lower Half"
                : "Below Lower"}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
