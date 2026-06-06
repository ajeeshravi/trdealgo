"""Built-in equity strategies: momentum, mean reversion, breakout, trend follow.

Options strategies live in :mod:`app.strategies.options_strategies`.
"""
from __future__ import annotations

from app.strategies.base import (
    Signal,
    SignalAction,
    StrategyBase,
    StrategyContext,
)
from app.strategies.indicators import atr, donchian, ema, rsi, sma


class MomentumStrategy(StrategyBase):
    key = "momentum"
    display_name = "Momentum (dual MA + RSI)"
    param_schema = {
        "fast": {"type": "int", "default": 20},
        "slow": {"type": "int", "default": 50},
        "rsi_period": {"type": "int", "default": 14},
        "rsi_floor": {"type": "number", "default": 50},
    }

    def generate(self, ctx: StrategyContext) -> Signal:
        c = ctx.bars["close"]
        fast = sma(c, self.params.get("fast", 20))
        slow = sma(c, self.params.get("slow", 50))
        r = rsi(c, self.params.get("rsi_period", 14))
        if len(c) < self.params.get("slow", 50) + 1:
            return Signal(ctx.symbol, SignalAction.HOLD)

        bullish = fast.iloc[-1] > slow.iloc[-1] and r.iloc[-1] > self.params.get("rsi_floor", 50)
        if ctx.position_qty == 0 and bullish:
            return Signal(ctx.symbol, SignalAction.ENTER_LONG, strength=min(1.0, r.iloc[-1] / 100))
        if ctx.position_qty > 0 and fast.iloc[-1] < slow.iloc[-1]:
            return Signal(ctx.symbol, SignalAction.EXIT)
        return Signal(ctx.symbol, SignalAction.HOLD)


class MeanReversionStrategy(StrategyBase):
    key = "mean_reversion"
    display_name = "Mean Reversion (RSI bands)"
    param_schema = {
        "rsi_period": {"type": "int", "default": 2},
        "oversold": {"type": "number", "default": 10},
        "exit_level": {"type": "number", "default": 60},
        "trend_filter": {"type": "int", "default": 200},
    }

    def generate(self, ctx: StrategyContext) -> Signal:
        c = ctx.bars["close"]
        if len(c) < self.params.get("trend_filter", 200) + 1:
            return Signal(ctx.symbol, SignalAction.HOLD)
        r = rsi(c, self.params.get("rsi_period", 2))
        long_ma = sma(c, self.params.get("trend_filter", 200))
        uptrend = c.iloc[-1] > long_ma.iloc[-1]
        if ctx.position_qty == 0 and uptrend and r.iloc[-1] < self.params.get("oversold", 10):
            return Signal(ctx.symbol, SignalAction.ENTER_LONG, strength=0.8)
        if ctx.position_qty > 0 and r.iloc[-1] > self.params.get("exit_level", 60):
            return Signal(ctx.symbol, SignalAction.EXIT)
        return Signal(ctx.symbol, SignalAction.HOLD)


class BreakoutStrategy(StrategyBase):
    key = "breakout"
    display_name = "Donchian Breakout"
    param_schema = {"entry_window": {"type": "int", "default": 20},
                    "exit_window": {"type": "int", "default": 10}}

    def generate(self, ctx: StrategyContext) -> Signal:
        df = ctx.bars
        ew = self.params.get("entry_window", 20)
        xw = self.params.get("exit_window", 10)
        if len(df) < ew + 1:
            return Signal(ctx.symbol, SignalAction.HOLD)
        lower_x, _ = donchian(df, xw)
        _, upper_e = donchian(df, ew)
        price = df["close"].iloc[-1]
        if ctx.position_qty == 0 and price >= upper_e.iloc[-2]:
            return Signal(ctx.symbol, SignalAction.ENTER_LONG)
        if ctx.position_qty > 0 and price <= lower_x.iloc[-2]:
            return Signal(ctx.symbol, SignalAction.EXIT)
        return Signal(ctx.symbol, SignalAction.HOLD)


class TrendFollowingStrategy(StrategyBase):
    key = "trend_following"
    display_name = "Trend Following (EMA + ATR trail)"
    param_schema = {"ema_fast": {"type": "int", "default": 50},
                    "ema_slow": {"type": "int", "default": 200},
                    "atr_period": {"type": "int", "default": 14},
                    "atr_mult": {"type": "number", "default": 3.0}}

    def generate(self, ctx: StrategyContext) -> Signal:
        c = ctx.bars["close"]
        slow_n = self.params.get("ema_slow", 200)
        if len(c) < slow_n + 1:
            return Signal(ctx.symbol, SignalAction.HOLD)
        ef = ema(c, self.params.get("ema_fast", 50))
        es = ema(c, slow_n)
        a = atr(ctx.bars, self.params.get("atr_period", 14)).iloc[-1]
        if ctx.position_qty == 0 and ef.iloc[-1] > es.iloc[-1]:
            return Signal(
                ctx.symbol,
                SignalAction.ENTER_LONG,
                meta={"stop_distance": float(a * self.params.get("atr_mult", 3.0))},
            )
        if ctx.position_qty > 0 and ef.iloc[-1] < es.iloc[-1]:
            return Signal(ctx.symbol, SignalAction.EXIT)
        return Signal(ctx.symbol, SignalAction.HOLD)
