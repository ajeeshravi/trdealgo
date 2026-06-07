"""No-code strategy evaluator.

Turns a no-code strategy ``definition`` (the JSON the frontend builder produces)
into a :class:`StrategyBase` that emits long/flat signals. The same evaluator is
used by the backtester and (eventually) the live engine, so a strategy behaves
identically in both.

Definition shape (subset we evaluate)::

    {
      "instrument_class": "EQUITY",
      "side": "LONG",
      "params": {"sizing": {"mode": "fixed_fraction", "fraction": 0.1}, ...},
      "entry": {"all": [Condition, ...]}  | {"any": [...]},
      "exit":  {"all": [...]}             | {"any": [...]}
    }

Supported condition ``type``s: ``compare``, ``crossover``, ``ema_cross``,
``rsi``, ``macd_cross``, ``breakout``. Unsupported types evaluate to ``False``
(conservative) so a strategy never enters on a rule we don't understand.

Supported expression nodes (inside ``compare``): indicator, constant, binary
(``+ - * /``), function (``sqrt``, ``abs``).
"""
from __future__ import annotations

import math
from decimal import Decimal
from typing import Any

import pandas as pd

from app.strategies.base import (
    PositionSizing,
    Signal,
    SignalAction,
    StrategyBase,
    StrategyContext,
)
from app.strategies.indicators import atr, bollinger, ema, macd, rsi, sma

_SOURCE_COLUMNS = {"open", "high", "low", "close", "volume"}


def _source_series(bars: pd.DataFrame, source: str | None) -> pd.Series:
    col = (source or "close").lower()
    if col in ("price", "last", "ltp"):
        col = "close"
    if col in _SOURCE_COLUMNS and col in bars.columns:
        return bars[col]
    return bars["close"]


def _indicator_series(bars: pd.DataFrame, expr: dict[str, Any]) -> pd.Series:
    name = str(expr.get("indicator", "close")).lower()
    params = expr.get("params") or {}
    period = int(params.get("period") or params.get("length") or params.get("window") or 14)
    src = _source_series(bars, expr.get("source"))

    if name in ("close", "price", "last", "ltp", "open", "high", "low", "volume"):
        series = _source_series(bars, name if name in _SOURCE_COLUMNS else expr.get("source"))
    elif name == "sma":
        series = sma(src, period)
    elif name == "ema":
        series = ema(src, period)
    elif name == "rsi":
        series = rsi(src, period)
    elif name == "atr":
        series = atr(bars, period)
    elif name == "macd":
        series = macd(src)[0]
    elif name == "macd_signal":
        series = macd(src)[1]
    elif name in ("bb_upper", "bb_lower", "bb_mid"):
        lower, mid, upper = bollinger(src, period)
        series = {"bb_lower": lower, "bb_mid": mid, "bb_upper": upper}[name]
    elif name == "vwap":
        series = bars["vwap"] if "vwap" in bars.columns else src
    else:
        # Unknown indicator: fall back to the source so a compare still resolves
        # numerically rather than crashing.
        series = src

    offset = int(expr.get("offset") or 0)
    return series.shift(offset) if offset else series


def _eval_expr(bars: pd.DataFrame, expr: Any) -> pd.Series:
    """Resolve an expression node to a Series aligned to ``bars.index``."""
    if isinstance(expr, int | float):
        return pd.Series(float(expr), index=bars.index)
    if not isinstance(expr, dict):
        return pd.Series(float("nan"), index=bars.index)
    if "value" in expr and "indicator" not in expr and "op" not in expr and "fn" not in expr:
        return pd.Series(float(expr["value"]), index=bars.index)
    if "fn" in expr:
        args = expr.get("args") or []
        a = _eval_expr(bars, args[0]) if args else pd.Series(float("nan"), index=bars.index)
        if expr["fn"] == "sqrt":
            return a.clip(lower=0).pow(0.5)
        if expr["fn"] == "abs":
            return a.abs()
        return a
    if "op" in expr and ("a" in expr or "b" in expr):
        a = _eval_expr(bars, expr.get("a"))
        b = _eval_expr(bars, expr.get("b"))
        op = expr["op"]
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return a / b.replace(0, float("nan"))
        return pd.Series(float("nan"), index=bars.index)
    # Otherwise treat as an indicator expression.
    return _indicator_series(bars, expr)


def _val(series: pd.Series, i: int = -1) -> float:
    try:
        v = float(series.iloc[i])
    except (IndexError, ValueError, TypeError):
        return float("nan")
    return v


def _cmp(a: float, op: str, b: float) -> bool:
    if math.isnan(a) or math.isnan(b):
        return False
    if op in (">", "gt"):
        return a > b
    if op in ("<", "lt"):
        return a < b
    if op in (">=", "gte", "ge"):
        return a >= b
    if op in ("<=", "lte", "le"):
        return a <= b
    if op in ("==", "eq"):
        return a == b
    if op in ("!=", "ne"):
        return a != b
    return False


def _crossed(left: pd.Series, right: pd.Series, direction: str) -> bool:
    if len(left) < 2 or len(right) < 2:
        return False
    lp, lc = _val(left, -2), _val(left, -1)
    rp, rc = _val(right, -2), _val(right, -1)
    if any(math.isnan(x) for x in (lp, lc, rp, rc)):
        return False
    if direction in ("up", "above", "crosses_above"):
        return lp <= rp and lc > rc
    return lp >= rp and lc < rc


def _eval_condition(bars: pd.DataFrame, cond: dict[str, Any]) -> bool:
    ctype = str(cond.get("type", "")).lower()

    if ctype == "compare":
        left = _eval_expr(bars, cond.get("left"))
        right = _eval_expr(bars, cond.get("right"))
        op = str(cond.get("op", ">"))
        if op in ("crosses_above", "crosses_below"):
            return _crossed(left, right, "up" if op == "crosses_above" else "down")
        return _cmp(_val(left), op, _val(right))

    if ctype == "crossover":
        left = _eval_expr(bars, cond.get("left"))
        right = _eval_expr(bars, cond.get("right"))
        return _crossed(left, right, str(cond.get("direction", "up")))

    if ctype == "ema_cross":
        c = bars["close"]
        fast = ema(c, int(cond.get("fast", 9)))
        slow = ema(c, int(cond.get("slow", 21)))
        return _crossed(fast, slow, str(cond.get("direction", "up")))

    if ctype == "macd_cross":
        line, signal, _ = macd(
            bars["close"],
            int(cond.get("fast", 12)),
            int(cond.get("slow", 26)),
            int(cond.get("signal", 9)),
        )
        return _crossed(line, signal, str(cond.get("direction", "up")))

    if ctype == "rsi":
        r = rsi(bars["close"], int(cond.get("period", 14)))
        return _cmp(_val(r), str(cond.get("op", "<")), float(cond.get("value", 30)))

    if ctype == "breakout":
        lookback = int(cond.get("lookback", 20))
        c = bars["close"]
        if str(cond.get("direction", "up")) in ("up", "above"):
            ref = bars["high"].rolling(lookback).max().shift(1)
            return _cmp(_val(c), ">", _val(ref))
        ref = bars["low"].rolling(lookback).min().shift(1)
        return _cmp(_val(c), "<", _val(ref))

    # Unsupported condition type — never trigger on a rule we don't understand.
    return False


def _eval_group(bars: pd.DataFrame, group: Any) -> bool:
    if not isinstance(group, dict):
        return False
    if "all" in group:
        conds = group.get("all") or []
        return bool(conds) and all(_eval_condition(bars, c) for c in conds)
    if "any" in group:
        conds = group.get("any") or []
        return any(_eval_condition(bars, c) for c in conds)
    return False


def _sizing_from_params(params: dict[str, Any]) -> PositionSizing:
    s = params.get("sizing") or {}
    mode = str(s.get("mode", "fixed_fraction"))
    try:
        fraction = Decimal(str(s.get("fraction", "0.1")))
    except Exception:
        fraction = Decimal("0.1")
    fixed_qty = s.get("fixed_qty")
    return PositionSizing(
        mode=mode,
        fraction=fraction,
        fixed_qty=Decimal(str(fixed_qty)) if fixed_qty else None,
    )


class NoCodeStrategy(StrategyBase):
    """Evaluates a no-code definition into long/flat signals."""

    key = "nocode"
    display_name = "No-code strategy"

    def __init__(self, definition: dict[str, Any] | None = None, **kw: Any) -> None:
        definition = definition or {}
        params = definition.get("params") or {}
        super().__init__(params=params, sizing=_sizing_from_params(params), **kw)
        self.definition = definition
        self.entry = definition.get("entry") or {}
        self.exit = definition.get("exit") or {}

    def generate(self, ctx: StrategyContext) -> Signal:
        if ctx.position_qty == 0:
            if _eval_group(ctx.bars, self.entry):
                return Signal(ctx.symbol, SignalAction.ENTER_LONG)
            return Signal(ctx.symbol, SignalAction.HOLD)
        if _eval_group(ctx.bars, self.exit):
            return Signal(ctx.symbol, SignalAction.EXIT)
        return Signal(ctx.symbol, SignalAction.HOLD)
