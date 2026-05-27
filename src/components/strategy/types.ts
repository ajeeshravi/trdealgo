/**
 * Visual-strategy-builder data model.
 *
 * The shape mirrors the JSON the no-code compiler at
 * backend/app/services/strategy/nocode.py understands.
 *
 * Core fields (`params`, `entry`, `exit`) drive evaluation. Phase-1
 * extensions (pyramiding, re-entry, partial exits, multi-timeframe,
 * position sizing, product, order type, time-window) live under
 * `params` so the engine can grow into them without breaking older rows.
 */

export type ComparisonOp = ">" | "<" | ">=" | "<=" | "==" | "!=";
export type Direction = "up" | "down";

/* ------------------ indicator expressions (compare / crossover) -------- */

export type IndicatorName =
  // raw price / volume
  | "close" | "high" | "low" | "open" | "volume"
  // overlays
  | "sma" | "ema" | "vwap"
  | "bb_upper" | "bb_middle" | "bb_lower"
  | "donchian_upper" | "donchian_mid" | "donchian_lower"
  | "supertrend"
  // oscillators
  | "rsi" | "atr" | "adx" | "cci"
  | "macd_line" | "macd_signal" | "macd_hist"
  | "stoch_k" | "stoch_d"
  // session-aware: sticky values from today's (or yesterday's) bars
  | "day_open" | "day_high" | "day_low"
  | "nth_open" | "nth_high" | "nth_low" | "nth_close"
  | "orb_high" | "orb_low"
  | "prev_day_close";

export type SourceField = "close" | "high" | "low" | "open" | "volume";

export interface IndicatorExpr {
  indicator: IndicatorName;
  params?: Record<string, number>;     // e.g. { period: 14 }
  source?: SourceField;                // input series (default: close)
  offset?: number;                     // 0 = current bar, -1 = previous, ...
  symbol?: string;                     // override the strategy's default symbol
}

export interface ConstantExpr {
  value: number;
}

/** Arithmetic on two child expressions. Each child can recursively be any
 *  Expr (constant, indicator, another binary op, or a function call) —
 *  so compound formulas like
 *  `open + open × close-on-VIX × sqrt(dte ÷ 365)` express as a small tree. */
export interface BinaryOpExpr {
  op: "+" | "-" | "*" | "/";
  a: Expr;
  b: Expr;
}

/** Unary math function (sqrt, abs). Wrapped in `args` (array) so future
 *  multi-arg functions like min/max slot in without a schema change. */
export interface FunctionExpr {
  fn: "sqrt" | "abs";
  args: [Expr];
}

export type Expr = IndicatorExpr | ConstantExpr | BinaryOpExpr | FunctionExpr;

/** Discriminator on an Expr — handy for the editor's mode selector. */
export type ExprKind = "indicator" | "constant" | BinaryOpExpr["op"] | FunctionExpr["fn"];

export function exprKindOf(expr: Expr): ExprKind {
  if ("op" in expr && ("a" in expr)) return expr.op;
  if ("fn" in expr) return expr.fn;
  if ("indicator" in expr) return "indicator";
  return "constant";
}

/* ------------------ conditions ---------------------------------------- */

export type ShortcutKind =
  | "ema_cross"
  | "rsi"
  | "supertrend"
  | "vwap_break"
  | "macd_cross"
  | "breakout"
  | "volume_spike"
  | "candle_pattern"
  | "time_trigger"
  | "dte";

export type Condition =
  /* generic comparison — both sides are arbitrary arithmetic Expr trees,
   * so formulas like `open > prev_day_close * 1.005` (gap fade) or
   * `close > SMA(20) + 2 * ATR(14)` are first-class. Back-compat: an
   * IndicatorExpr is a leaf-shaped Expr, so older stored conditions still
   * deserialise without migration. */
  | {
      id: string;
      type: "compare";
      left: Expr;
      op: ComparisonOp;
      right: Expr;
      timeframe?: string;
    }
  /* generic indicator-vs-indicator crossover (up = left crosses above right) */
  | {
      id: string;
      type: "crossover";
      left: IndicatorExpr;
      right: IndicatorExpr;
      direction: Direction;
      timeframe?: string;
    }
  /* back-compat shortcuts (rendered with a simpler one-line UI) */
  | {
      id: string;
      type: "ema_cross";
      fast: number;
      slow: number;
      direction: Direction;
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "rsi";
      period: number;
      op: ComparisonOp;
      value: number;
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "supertrend";
      period: number;
      mult: number;
      direction: Direction;
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "vwap_break";
      direction: "above" | "below";
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "macd_cross";
      fast: number;
      slow: number;
      signal: number;
      direction: Direction;
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "breakout";
      lookback: number;
      direction: Direction;
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "volume_spike";
      lookback: number;
      factor: number;
      symbol?: string;
      timeframe?: string;
    }
  | {
      id: string;
      type: "candle_pattern";
      pattern: "bullish_engulfing" | "bearish_engulfing" | "doji";
      symbol?: string;
      timeframe?: string;
    }
  /* Time-of-day trigger — fires true on the first candle whose close-time
   * crosses or equals the target HH:MM each day. Use case: scheduled
   * option entries like "open ATM straddle at 09:20 every day". Works
   * standalone (no indicator needed) so a single time_trigger as the
   * entry rule = pure time-driven entry. */
  | {
      id: string;
      type: "time_trigger";
      at: string;          // "HH:MM" — IST
      symbol?: string;
      timeframe?: string;
    }
  /* Days-to-expiry (OPTIONS only). Compares the basket's resolved-leg
   * expiry against today's date. Use cases: 0DTE-only entries (op: "==",
   * value: 0), avoid-expiry-day (op: ">", value: 0), weekly-strike
   * windows (op: "<=", value: 7), etc.
   * For multi-leg baskets with mixed expiries (calendar spreads), this
   * reads leg 0's expiry. */
  | {
      id: string;
      type: "dte";
      op: ComparisonOp;
      value: number;       // days
      symbol?: string;
      timeframe?: string;
    };

export type ConditionKind = Condition["type"];

export interface RuleGroup {
  combinator: "all" | "any";
  conditions: Condition[];
}

/* ------------------ sizing / advanced / risk -------------------------- */

export type SizingMode =
  | "FIXED_QTY"
  | "CAPITAL_PER_SYMBOL"
  | "PCT_OF_CAPITAL"
  | "RISK_BASED"
  | "LOTS";              // futures only — N lots × lot_size

export interface PositionSizing {
  mode: SizingMode;
  fixed_qty?: number;
  capital_per_symbol?: number;
  pct_of_capital?: number;
  risk_pct?: number;
  lots?: number;         // futures-only count of lots when mode == "LOTS"
}

export interface PyramidingConfig {
  enabled: boolean;
  max_adds: number;
  trigger: "same_signal" | "price_step";
  price_step_pct?: number;
  qty_multiplier?: number;
}

export interface ReentryConfig {
  enabled: boolean;
  after: "sl_hit" | "target_hit" | "any_exit";
  max_per_day: number;
  cooldown_candles: number;
}

export interface PartialExitLeg {
  id: string;
  qty_pct: number;
  target_pct: number;
}

export interface PartialExitConfig {
  enabled: boolean;
  legs: PartialExitLeg[];
  trail_remainder: boolean;
}

export interface TimeFilters {
  enabled: boolean;
  entry_start?: string;      // "HH:MM"
  entry_end?: string;        // "HH:MM"
}

export interface RiskRules {
  max_qty_per_order?: number;
  max_open_positions?: number;
  max_daily_loss?: number;
  max_daily_profit?: number;
  max_drawdown?: number;
  stop_loss_pct?: number;
  target_pct?: number;
  trailing_sl_pct?: number;
  consecutive_loss_shutdown?: number;
  time_based_exit?: string;
  force_square_off: boolean;
}

export type ProductType = "MIS" | "CNC" | "NRML";
export type OrderType = "MARKET" | "LIMIT";

/** Direction the strategy opens its position in.
 *  - LONG  → entry = BUY,  exit = SELL  (default; also the only legal value for EQUITY+CNC)
 *  - SHORT → entry = SELL, exit = BUY
 *  Cash equity intraday (MIS) supports SHORT; CNC (delivery) does not.
 *  Futures support both for MIS and NRML. Options use OptionsConfig.action
 *  instead, which expresses BUY/SELL of the CE/PE leg directly. */
export type StrategySide = "LONG" | "SHORT";

/** For OPTIONS-class strategies: whether the engine should BUY or SELL
 *  (write) the chosen CE/PE leg on entry. The closing leg is always the
 *  opposite side. */
export type OptionAction = "BUY" | "SELL";

/** Named multi-leg presets the panel offers as one-click shortcuts. CUSTOM
 *  means the user assembled the legs manually (or edited a preset enough
 *  that it no longer matches). Used purely as a UX label — the engine reads
 *  the legs array, not the preset name. */
export type OptionStrategyPreset =
  | "SINGLE"
  | "STRADDLE_LONG"
  | "STRADDLE_SHORT"
  | "STRANGLE_LONG"
  | "STRANGLE_SHORT"
  | "BULL_CALL_SPREAD"
  | "BEAR_PUT_SPREAD"
  | "IRON_CONDOR"
  | "CUSTOM";

/** One leg of a multi-leg option basket. The engine resolves each leg
 *  independently against the underlying's option chain at signal time,
 *  then places the leg's order with shared `basket_id` metadata so the
 *  whole basket can be grouped in the activity feed.
 *
 *  `qty_ratio` is a multiplier of the strategy's base sizing (1 = base
 *  lots, 2 = double, 0.5 = half) — useful for ratio spreads / butterflies
 *  where one leg has twice the contracts of the others. */
export interface OptionLeg {
  /** Local-only React key — never serialised to the wire (stripped in
   *  toDefinition like RuleGroup conditions). */
  id: string;
  option_type: OptionType;
  action: OptionAction;
  strike_mode: StrikeMode;
  strike_offset: number;
  expiry_alias: ExpiryAlias;
  qty_ratio: number;
}

/** Strategy instrument class.
 *  - EQUITY: cash-segment shares.
 *  - FUTURES: single futures contract.
 *  - OPTIONS: single-leg options. User picks an underlying (index or stock);
 *    the engine resolves the actual contract (CE/PE, strike, expiry) per
 *    candle via the strategy's `OptionsConfig`. Multi-leg builds (verticals,
 *    straddles, iron condors) land in a follow-up phase.
 */
export type InstrumentClass = "EQUITY" | "FUTURES" | "OPTIONS";

/** Phase 1 single-leg options config. Stored on `definition.params.option_config`. */
export type OptionType = "CE" | "PE";
export type StrikeMode = "ATM" | "OFFSET";
export type ExpiryAlias = "CURRENT" | "NEXT";

/** Which price feed the strategy's indicators evaluate against.
 *  - FUTURES: front-month futures of the underlying (default — most stable
 *    intraday reference, tracks spot tightly).
 *  - SPOT:    cash spot index / cash equity for the underlying. Useful for
 *    strategies driven by the index level rather than basis.
 *  - PREMIUM: the option contract's own price feed. Indicators evaluate
 *    on premium directly; orders go to the same contract.
 */
export type OptionsFeedSource = "FUTURES" | "SPOT" | "PREMIUM";

/** Strategy-level options config. Phase C reshapes the previous flat
 *  single-leg shape (option_type/strike_mode/etc.) into a `legs[]` array.
 *  A single-leg basket is just `legs.length === 1`. The `feed_source` is
 *  strategy-level (all legs share the same indicator feed). */
export interface OptionsConfig {
  /** Which price feed indicators evaluate on. Defaults to FUTURES. */
  feed_source: OptionsFeedSource;
  /** UX-only label tracking which preset the legs were generated from.
   *  Reverts to CUSTOM when the user mutates legs away from a preset. */
  preset: OptionStrategyPreset;
  /** One row per leg. Always non-empty (default = one ATM CE BUY). */
  legs: OptionLeg[];
}

/** Tracks the source of the strategy's symbol list for UX continuity:
 *  basket_id is reference-only — symbols are still materialised in
 *  `form.symbols` at submission time. */
export interface BasketSource {
  basket_id: string;
  basket_name: string;
}

export interface EquityStrategyForm {
  /** Equity (NSE/BSE cash) or Futures (NFO/BFO/MCX/CDS).
   *  Affects: symbol picker filter, available product types, available
   *  sizing modes, and how the engine computes order qty. */
  instrument_class: InstrumentClass;
  /** Whether entries open a LONG or SHORT position.
   *  - EQUITY: LONG always; SHORT only legal when product == "MIS".
   *  - FUTURES: both legal for MIS and NRML.
   *  - OPTIONS: ignored — option direction lives on each leg's `action`
   *    (BUY/SELL the CE/PE leg). Form pins this to LONG for OPTIONS. */
  side: StrategySide;
  name: string;
  description: string;
  symbols: string[];
  basket_source?: BasketSource;        // optional — populated by "Import basket"
  timeframe_min: number;
  capital: number;
  product: ProductType;
  order_type: OrderType;
  limit_offset_pct: number;
  sizing: PositionSizing;
  time_filters: TimeFilters;
  entry: RuleGroup;
  exit: RuleGroup;
  pyramiding: PyramidingConfig;
  reentry: ReentryConfig;
  partial_exits: PartialExitConfig;
  risk: RiskRules;
  /** Only meaningful when `instrument_class === "OPTIONS"`. Kept on every
   *  form so the field doesn't disappear when the user toggles tabs and back. */
  options: OptionsConfig;
  /** Auto-start this strategy when the named broker account auto-logs-in.
   *  These three move together: toggle is only honored on the backend when
   *  a broker is picked. Stored as real columns on the strategies table
   *  (NOT inside `definition`), so they survive a definition rebuild. */
  auto_start_on_login: boolean;
  auto_start_broker_account_id: string | null;
  auto_start_is_paper: boolean;
}

/** Alias kept so future renames don't ripple through every consumer. */
export type StrategyForm = EquityStrategyForm;

/* ------------------ defaults ----------------------------------------- */

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Indicators a user can pick on either side of a compare/crossover. */
export const INDICATOR_CATALOG: { name: IndicatorName; label: string; params: { key: string; label: string; default: number; step?: number }[] }[] = [
  { name: "close",  label: "Close price",  params: [] },
  { name: "high",   label: "High",         params: [] },
  { name: "low",    label: "Low",          params: [] },
  { name: "open",   label: "Open",         params: [] },
  { name: "volume", label: "Volume",       params: [] },
  { name: "sma",    label: "SMA",          params: [{ key: "period", label: "Period", default: 14 }] },
  { name: "ema",    label: "EMA",          params: [{ key: "period", label: "Period", default: 14 }] },
  { name: "rsi",    label: "RSI",          params: [{ key: "period", label: "Period", default: 14 }] },
  { name: "atr",    label: "ATR",          params: [{ key: "period", label: "Period", default: 14 }] },
  { name: "adx",    label: "ADX",          params: [{ key: "period", label: "Period", default: 14 }] },
  { name: "cci",    label: "CCI",          params: [{ key: "period", label: "Period", default: 20 }] },
  { name: "vwap",   label: "VWAP",         params: [] },
  { name: "supertrend", label: "Supertrend (line)", params: [
      { key: "period", label: "Period", default: 10 },
      { key: "mult",   label: "Mult",   default: 3, step: 0.1 },
  ]},
  { name: "macd_line",   label: "MACD line",   params: [
      { key: "fast", label: "Fast", default: 12 },
      { key: "slow", label: "Slow", default: 26 },
      { key: "signal", label: "Signal", default: 9 },
  ]},
  { name: "macd_signal", label: "MACD signal", params: [
      { key: "fast", label: "Fast", default: 12 },
      { key: "slow", label: "Slow", default: 26 },
      { key: "signal", label: "Signal", default: 9 },
  ]},
  { name: "macd_hist",   label: "MACD histogram", params: [
      { key: "fast", label: "Fast", default: 12 },
      { key: "slow", label: "Slow", default: 26 },
      { key: "signal", label: "Signal", default: 9 },
  ]},
  { name: "stoch_k", label: "Stochastic %K", params: [
      { key: "k_period", label: "K period", default: 14 },
      { key: "d_period", label: "D period", default: 3 },
  ]},
  { name: "stoch_d", label: "Stochastic %D", params: [
      { key: "k_period", label: "K period", default: 14 },
      { key: "d_period", label: "D period", default: 3 },
  ]},
  { name: "bb_upper",  label: "Bollinger upper",  params: [
      { key: "period", label: "Period", default: 20 },
      { key: "k",      label: "Std dev", default: 2, step: 0.1 },
  ]},
  { name: "bb_middle", label: "Bollinger middle", params: [
      { key: "period", label: "Period", default: 20 },
      { key: "k",      label: "Std dev", default: 2, step: 0.1 },
  ]},
  { name: "bb_lower",  label: "Bollinger lower",  params: [
      { key: "period", label: "Period", default: 20 },
      { key: "k",      label: "Std dev", default: 2, step: 0.1 },
  ]},
  { name: "donchian_upper", label: "Donchian upper", params: [{ key: "period", label: "Period", default: 20 }] },
  { name: "donchian_mid",   label: "Donchian mid",   params: [{ key: "period", label: "Period", default: 20 }] },
  { name: "donchian_lower", label: "Donchian lower", params: [{ key: "period", label: "Period", default: 20 }] },
  // Session-aware values. day_*: today's session aggregates (sticky to the
  // current trading date). nth_*: pick a specific Nth candle of today
  // (n=0 means first candle of the day). orb_*: opening-range over the
  // first `bars` candles. prev_day_close: yesterday's last close (gap calc).
  { name: "day_open",  label: "Day open (today's first candle open)",  params: [] },
  { name: "day_high",  label: "Day high (today running)",              params: [] },
  { name: "day_low",   label: "Day low (today running)",               params: [] },
  { name: "nth_open",  label: "Nth candle open",   params: [{ key: "n", label: "N (0=first)", default: 0 }] },
  { name: "nth_high",  label: "Nth candle high",   params: [{ key: "n", label: "N (0=first)", default: 0 }] },
  { name: "nth_low",   label: "Nth candle low",    params: [{ key: "n", label: "N (0=first)", default: 0 }] },
  { name: "nth_close", label: "Nth candle close",  params: [{ key: "n", label: "N (0=first)", default: 0 }] },
  { name: "orb_high",  label: "Opening-range high", params: [{ key: "bars", label: "Bars", default: 3 }] },
  { name: "orb_low",   label: "Opening-range low",  params: [{ key: "bars", label: "Bars", default: 3 }] },
  { name: "prev_day_close", label: "Previous day's close", params: [] },
];

export function indicatorMeta(name: IndicatorName) {
  return INDICATOR_CATALOG.find((i) => i.name === name) ?? INDICATOR_CATALOG[0];
}

export function defaultIndicatorExpr(name: IndicatorName = "ema"): IndicatorExpr {
  const meta = indicatorMeta(name);
  const params: Record<string, number> = {};
  for (const p of meta.params) params[p.key] = p.default;
  return { indicator: name, params, source: "close", offset: 0 };
}

/** Wrap an existing expression in a binary op, preserving the user's work
 *  as the LHS so switching modes mid-edit doesn't lose state. */
export function wrapInBinary(
  prev: Expr,
  op: BinaryOpExpr["op"],
): BinaryOpExpr {
  return { op, a: prev, b: { value: 0 } };
}

/** Wrap an existing expression as the single argument of a function call. */
export function wrapInFunction(
  prev: Expr,
  fn: FunctionExpr["fn"],
): FunctionExpr {
  return { fn, args: [prev] };
}

export function defaultOptionLeg(
  overrides: Partial<Omit<OptionLeg, "id">> = {},
): OptionLeg {
  return {
    id: newId("leg"),
    option_type: "CE",
    action: "BUY",
    strike_mode: "ATM",
    strike_offset: 0,
    expiry_alias: "CURRENT",
    qty_ratio: 1,
    ...overrides,
  };
}

/** Generates the leg array for a named preset. Strike offsets are in
 *  *strike steps* — the resolver translates that to the underlying's
 *  strike interval at signal time (NIFTY 50, BANKNIFTY 100, etc.). */
export function legsForPreset(preset: OptionStrategyPreset): OptionLeg[] {
  switch (preset) {
    case "STRADDLE_LONG":
      return [
        defaultOptionLeg({ option_type: "CE", action: "BUY", strike_mode: "ATM", strike_offset: 0 }),
        defaultOptionLeg({ option_type: "PE", action: "BUY", strike_mode: "ATM", strike_offset: 0 }),
      ];
    case "STRADDLE_SHORT":
      return [
        defaultOptionLeg({ option_type: "CE", action: "SELL", strike_mode: "ATM", strike_offset: 0 }),
        defaultOptionLeg({ option_type: "PE", action: "SELL", strike_mode: "ATM", strike_offset: 0 }),
      ];
    case "STRANGLE_LONG":
      return [
        defaultOptionLeg({ option_type: "CE", action: "BUY", strike_mode: "OFFSET", strike_offset: 2 }),
        defaultOptionLeg({ option_type: "PE", action: "BUY", strike_mode: "OFFSET", strike_offset: -2 }),
      ];
    case "STRANGLE_SHORT":
      return [
        defaultOptionLeg({ option_type: "CE", action: "SELL", strike_mode: "OFFSET", strike_offset: 2 }),
        defaultOptionLeg({ option_type: "PE", action: "SELL", strike_mode: "OFFSET", strike_offset: -2 }),
      ];
    case "BULL_CALL_SPREAD":
      return [
        defaultOptionLeg({ option_type: "CE", action: "BUY", strike_mode: "ATM", strike_offset: 0 }),
        defaultOptionLeg({ option_type: "CE", action: "SELL", strike_mode: "OFFSET", strike_offset: 2 }),
      ];
    case "BEAR_PUT_SPREAD":
      return [
        defaultOptionLeg({ option_type: "PE", action: "BUY", strike_mode: "ATM", strike_offset: 0 }),
        defaultOptionLeg({ option_type: "PE", action: "SELL", strike_mode: "OFFSET", strike_offset: -2 }),
      ];
    case "IRON_CONDOR":
      return [
        // Short the OTM put + OTM call (collect premium), buy further-OTM
        // wings to cap risk. Classic range-bound trade.
        defaultOptionLeg({ option_type: "PE", action: "BUY", strike_mode: "OFFSET", strike_offset: -4 }),
        defaultOptionLeg({ option_type: "PE", action: "SELL", strike_mode: "OFFSET", strike_offset: -2 }),
        defaultOptionLeg({ option_type: "CE", action: "SELL", strike_mode: "OFFSET", strike_offset: 2 }),
        defaultOptionLeg({ option_type: "CE", action: "BUY", strike_mode: "OFFSET", strike_offset: 4 }),
      ];
    case "SINGLE":
    case "CUSTOM":
    default:
      return [defaultOptionLeg()];
  }
}

export function defaultCondition(kind: ConditionKind): Condition {
  switch (kind) {
    case "compare":
      return {
        id: newId("c"),
        type: "compare",
        left: defaultIndicatorExpr("ema"),
        op: ">",
        right: { value: 0 },
      };
    case "crossover":
      return {
        id: newId("c"),
        type: "crossover",
        left:  { ...defaultIndicatorExpr("ema"), params: { period: 9 } },
        right: { ...defaultIndicatorExpr("ema"), params: { period: 21 } },
        direction: "up",
      };
    case "ema_cross":
      return { id: newId("c"), type: "ema_cross", fast: 9, slow: 21, direction: "up" };
    case "rsi":
      return { id: newId("c"), type: "rsi", period: 14, op: ">", value: 55 };
    case "supertrend":
      return { id: newId("c"), type: "supertrend", period: 10, mult: 3, direction: "up" };
    case "vwap_break":
      return { id: newId("c"), type: "vwap_break", direction: "above" };
    case "macd_cross":
      return { id: newId("c"), type: "macd_cross", fast: 12, slow: 26, signal: 9, direction: "up" };
    case "breakout":
      return { id: newId("c"), type: "breakout", lookback: 20, direction: "up" };
    case "volume_spike":
      return { id: newId("c"), type: "volume_spike", lookback: 20, factor: 2 };
    case "candle_pattern":
      return { id: newId("c"), type: "candle_pattern", pattern: "bullish_engulfing" };
    case "time_trigger":
      return { id: newId("c"), type: "time_trigger", at: "09:20" };
    case "dte":
      // Default to "0DTE only" — the single most-asked use case for
      // option strategies and unambiguous as a starting point.
      return { id: newId("c"), type: "dte", op: "==", value: 0 };
  }
}

export function defaultForm(instrument_class: InstrumentClass = "EQUITY"): EquityStrategyForm {
  const isFut = instrument_class === "FUTURES";
  const isOpt = instrument_class === "OPTIONS";
  const isLotAware = isFut || isOpt;
  return {
    instrument_class,
    side: "LONG",
    name: "",
    description: "",
    symbols: [],
    timeframe_min: 5,
    capital: 100000,
    // Options are typically traded intraday; NRML lets the position carry
    // overnight if the user wants. Default to MIS for intraday safety.
    product: isFut ? "NRML" : isOpt ? "MIS" : "MIS",
    order_type: "MARKET",
    limit_offset_pct: 0.05,
    sizing: isLotAware
      ? { mode: "LOTS", lots: 1 }
      : { mode: "CAPITAL_PER_SYMBOL", capital_per_symbol: 50000 },
    time_filters: { enabled: false, entry_start: "09:30", entry_end: "15:00" },
    // Start blank so the user assembles their own rules rather than
    // deleting the pre-filled examples. validateForm() still blocks
    // submit until at least one entry condition is added.
    entry: { combinator: "all", conditions: [] },
    exit: { combinator: "any", conditions: [] },
    pyramiding: {
      enabled: false,
      max_adds: 2,
      trigger: "price_step",
      price_step_pct: 0.01,
      qty_multiplier: 1,
    },
    reentry: {
      enabled: false,
      after: "any_exit",
      max_per_day: 2,
      cooldown_candles: 3,
    },
    partial_exits: {
      enabled: false,
      legs: [
        { id: newId("leg"), qty_pct: 50, target_pct: 0.01 },
        { id: newId("leg"), qty_pct: 30, target_pct: 0.02 },
      ],
      trail_remainder: true,
    },
    risk: {
      max_qty_per_order: 100,
      max_open_positions: 5,
      max_daily_loss: 2000,
      stop_loss_pct: 0.01,
      target_pct: 0.02,
      time_based_exit: "15:15",
      force_square_off: true,
    },
    options: {
      feed_source: "FUTURES",
      preset: "SINGLE",
      legs: [defaultOptionLeg()],
    },
    auto_start_on_login: false,
    auto_start_broker_account_id: null,
    auto_start_is_paper: false,
  };
}

/* ------------------ JSON emission ----------------------------------- */

function stripIds(g: RuleGroup): Record<string, unknown> {
  return {
    [g.combinator]: g.conditions.map(({ id: _id, ...rest }) => rest),
  };
}

/** Re-attach a synthetic id to every condition so React keys stay stable
 *  after a round-trip through the backend. */
function rehydrateGroup(raw: unknown, fallbackCombinator: "all" | "any"): RuleGroup {
  if (!raw || typeof raw !== "object") {
    return { combinator: fallbackCombinator, conditions: [] };
  }
  const obj = raw as Record<string, unknown>;
  const combinator: "all" | "any" =
    Array.isArray(obj.all) ? "all" : Array.isArray(obj.any) ? "any" : fallbackCombinator;
  const list = (obj[combinator] as unknown[]) || [];
  const conditions: Condition[] = list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({ id: newId("c"), ...(c as object) }) as Condition);
  return { combinator, conditions };
}

/** Inverse of `toDefinition`. Rebuilds the form from what we stored in the
 *  backend so the edit page can prefill every field the user picked.
 *
 *  Anything missing (older strategies, partial blobs) falls back to the
 *  defaults from `defaultForm()` — i.e. the form is always renderable, just
 *  not always fully prefilled.
 */
export function fromDefinition(
  strategy: {
    name: string;
    description?: string | null;
    symbols: string[];
    timeframe_min: number | null;
    capital: number;
    definition: Record<string, unknown> | null | undefined;
    risk?: Partial<RiskRules> | null;
    auto_start_on_login?: boolean | null;
    auto_start_broker_account_id?: string | null;
    auto_start_is_paper?: boolean | null;
  },
): EquityStrategyForm {
  const def = (strategy.definition || {}) as Record<string, unknown>;
  const params = (def.params || {}) as Record<string, unknown>;
  // Pick the right defaults branch up-front so e.g. sizing falls back to
  // a futures-shaped default when reading a futures strategy.
  const declaredClass = (def.instrument_class as InstrumentClass) || "EQUITY";
  const base = defaultForm(declaredClass);

  const sizing = (params.sizing as Partial<PositionSizing>) || base.sizing;
  const tf = (params.time_filters as Partial<TimeFilters>) || null;
  const py = (params.pyramiding as Partial<PyramidingConfig>) || null;
  const re = (params.reentry as Partial<ReentryConfig>) || null;
  const pe = (params.partial_exits as Partial<PartialExitConfig> & { legs?: PartialExitLeg[] }) || null;

  const entry = rehydrateGroup(def.entry, "all");
  const exit = rehydrateGroup(def.exit, "any");

  const declaredSide: StrategySide =
    params.side === "SHORT" || def.side === "SHORT" ? "SHORT" : "LONG";

  return {
    ...base,
    instrument_class: declaredClass,
    side: declaredSide,
    name: strategy.name,
    description: strategy.description || "",
    symbols: strategy.symbols || [],
    basket_source: (params.basket_source as BasketSource | undefined) || undefined,
    timeframe_min: strategy.timeframe_min ?? base.timeframe_min,
    capital: Number(strategy.capital ?? 0) || base.capital,
    product: (params.product as ProductType) || base.product,
    order_type: (params.order_type as OrderType) || base.order_type,
    limit_offset_pct:
      typeof params.limit_offset_pct === "number" ? params.limit_offset_pct : base.limit_offset_pct,
    sizing: { ...base.sizing, ...sizing },
    time_filters: tf
      ? { enabled: true, entry_start: tf.entry_start, entry_end: tf.entry_end }
      : base.time_filters,
    entry: entry.conditions.length ? entry : base.entry,
    exit: exit.conditions.length ? exit : base.exit,
    pyramiding: py ? { ...base.pyramiding, ...py, enabled: true } : base.pyramiding,
    reentry: re ? { ...base.reentry, ...re, enabled: true } : base.reentry,
    partial_exits: pe
      ? {
          ...base.partial_exits,
          ...pe,
          enabled: true,
          legs: (pe.legs || []).map((l) => ({ ...l, id: newId("leg") })),
        }
      : base.partial_exits,
    risk: { ...base.risk, ...(strategy.risk || {}) },
    options: rehydrateOptionsConfig(params.option_config, base.options),
    auto_start_on_login: Boolean(strategy.auto_start_on_login),
    auto_start_broker_account_id: strategy.auto_start_broker_account_id ?? null,
    auto_start_is_paper: Boolean(strategy.auto_start_is_paper),
  };
}

/** Build a usable OptionsConfig from whatever the backend returns.
 *
 *  Three input shapes are accepted, in order of priority:
 *  1. New multi-leg shape: `{ feed_source, preset, legs: [...] }`
 *  2. Legacy single-leg shape: `{ option_type, strike_mode, strike_offset,
 *     expiry_alias, feed_source, action }` — synthesised into a 1-leg array
 *     so older Phase-1/2 strategies stay editable.
 *  3. Missing / unrecognised — returns the base default (one ATM CE BUY).
 *
 *  Always returns at least one leg so the form is renderable. */
function rehydrateOptionsConfig(
  raw: unknown,
  base: OptionsConfig,
): OptionsConfig {
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const feed_source =
    (obj.feed_source as OptionsFeedSource) || base.feed_source;
  // Path 1: new multi-leg shape.
  const rawLegs = Array.isArray(obj.legs) ? (obj.legs as unknown[]) : null;
  if (rawLegs && rawLegs.length > 0) {
    const legs = rawLegs.map((r) => hydrateLeg(r));
    const presetRaw = typeof obj.preset === "string" ? obj.preset : "CUSTOM";
    const preset = isValidPreset(presetRaw) ? presetRaw : "CUSTOM";
    return { feed_source, preset, legs };
  }
  // Path 2: legacy single-leg fields. Wrap into a 1-leg basket.
  if (typeof obj.option_type === "string") {
    return {
      feed_source,
      preset: "SINGLE",
      legs: [
        hydrateLeg({
          option_type: obj.option_type,
          action: obj.action ?? "BUY",
          strike_mode: obj.strike_mode ?? "ATM",
          strike_offset: obj.strike_offset ?? 0,
          expiry_alias: obj.expiry_alias ?? "CURRENT",
          qty_ratio: 1,
        }),
      ],
    };
  }
  return base;
}

function hydrateLeg(raw: unknown): OptionLeg {
  const fallback = defaultOptionLeg();
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const opt = typeof o.option_type === "string" ? o.option_type.toUpperCase() : "";
  const act = typeof o.action === "string" ? o.action.toUpperCase() : "";
  const mode = typeof o.strike_mode === "string" ? o.strike_mode.toUpperCase() : "";
  const exp = typeof o.expiry_alias === "string" ? o.expiry_alias.toUpperCase() : "";
  return {
    id: newId("leg"),
    option_type: opt === "CE" || opt === "PE" ? (opt as OptionType) : fallback.option_type,
    action: act === "BUY" || act === "SELL" ? (act as OptionAction) : fallback.action,
    strike_mode:
      mode === "ATM" || mode === "OFFSET" ? (mode as StrikeMode) : fallback.strike_mode,
    strike_offset:
      typeof o.strike_offset === "number" ? Math.trunc(o.strike_offset) : fallback.strike_offset,
    expiry_alias:
      exp === "CURRENT" || exp === "NEXT" ? (exp as ExpiryAlias) : fallback.expiry_alias,
    qty_ratio:
      typeof o.qty_ratio === "number" && o.qty_ratio > 0 ? o.qty_ratio : fallback.qty_ratio,
  };
}

const PRESET_VALUES: OptionStrategyPreset[] = [
  "SINGLE",
  "STRADDLE_LONG",
  "STRADDLE_SHORT",
  "STRANGLE_LONG",
  "STRANGLE_SHORT",
  "BULL_CALL_SPREAD",
  "BEAR_PUT_SPREAD",
  "IRON_CONDOR",
  "CUSTOM",
];

function isValidPreset(v: string): v is OptionStrategyPreset {
  return (PRESET_VALUES as string[]).includes(v);
}

export function toDefinition(f: EquityStrategyForm): Record<string, unknown> {
  // OPTIONS strategies express direction via options.action (BUY/SELL the
  // leg), not the top-level side flag. Pin `side` to LONG so the engine's
  // generic side-flip path doesn't double up with the options-action path.
  const effectiveSide: StrategySide =
    f.instrument_class === "OPTIONS" ? "LONG" : f.side;
  return {
    // Top-level + duplicated under params so both the API validator and the
    // engine see it without poking around.
    instrument_class: f.instrument_class,
    side: effectiveSide,
    params: {
      instrument_class: f.instrument_class,
      side: effectiveSide,
      product: f.product,
      order_type: f.order_type,
      limit_offset_pct: f.limit_offset_pct,
      sizing: f.sizing,
      capital_per_symbol:
        f.sizing.mode === "CAPITAL_PER_SYMBOL"
          ? f.sizing.capital_per_symbol
          : undefined,
      time_filters: f.time_filters.enabled
        ? {
            entry_start: f.time_filters.entry_start,
            entry_end: f.time_filters.entry_end,
          }
        : undefined,
      basket_source: f.basket_source,
      pyramiding: f.pyramiding.enabled ? f.pyramiding : undefined,
      reentry: f.reentry.enabled ? f.reentry : undefined,
      partial_exits: f.partial_exits.enabled
        ? { ...f.partial_exits, legs: f.partial_exits.legs.map(({ id: _id, ...rest }) => rest) }
        : undefined,
      // Only emit option_config for OPTIONS strategies. Equity/futures pass
      // `undefined` so the backend's nocode engine doesn't fall into the
      // OPTIONS branch by accident on a JSON shape that has stale options
      // data left over from a tab switch. Multi-leg basket: legs[] is the
      // source of truth; local React-only `id`s are stripped before send.
      option_config:
        f.instrument_class === "OPTIONS"
          ? {
              feed_source: f.options.feed_source,
              preset: f.options.preset,
              legs: f.options.legs.map(({ id: _id, ...rest }) => rest),
            }
          : undefined,
    },
    entry: stripIds(f.entry),
    exit: stripIds(f.exit),
  };
}
