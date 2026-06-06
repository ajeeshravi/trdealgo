"""Options strategies: covered call, wheel, iron condor.

These strategies operate at a higher level than equity strategies: they decide
*when* to deploy a defined structure based on IV rank, DTE, and position state.
The actual multi-leg OrderRequest is built via :mod:`app.options.chain`.
"""
from __future__ import annotations

from decimal import Decimal

from app.brokers.models import AssetClass
from app.strategies.base import (
    Signal,
    SignalAction,
    StrategyBase,
    StrategyContext,
)
from app.strategies.indicators import sma


class CoveredCallStrategy(StrategyBase):
    """Hold (or buy) 100 shares per contract, sell OTM calls against them."""

    key = "covered_call"
    display_name = "Covered Call"
    asset_classes = (AssetClass.OPTION,)
    param_schema = {
        "target_delta": {"type": "number", "default": 0.30},
        "min_iv_rank": {"type": "number", "default": 30},
        "dte": {"type": "int", "default": 30},
    }

    def generate(self, ctx: StrategyContext) -> Signal:
        iv_rank = ctx.extras.get("iv_rank", 0)
        has_calls = ctx.extras.get("short_calls_open", 0) > 0
        if not has_calls and iv_rank >= self.params.get("min_iv_rank", 30):
            return Signal(
                ctx.symbol, SignalAction.ENTER_SHORT, asset_class=AssetClass.OPTION,
                meta={"structure": "covered_call",
                      "target_delta": self.params.get("target_delta", 0.30),
                      "dte": self.params.get("dte", 30)},
            )
        return Signal(ctx.symbol, SignalAction.HOLD)


class WheelStrategy(StrategyBase):
    """Sell cash-secured puts; if assigned, sell covered calls; repeat."""

    key = "wheel"
    display_name = "The Wheel"
    asset_classes = (AssetClass.OPTION,)
    param_schema = {
        "put_delta": {"type": "number", "default": 0.30},
        "call_delta": {"type": "number", "default": 0.30},
        "min_iv_rank": {"type": "number", "default": 30},
        "dte": {"type": "int", "default": 30},
    }

    def generate(self, ctx: StrategyContext) -> Signal:
        iv_rank = ctx.extras.get("iv_rank", 0)
        if iv_rank < self.params.get("min_iv_rank", 30):
            return Signal(ctx.symbol, SignalAction.HOLD)
        if ctx.position_qty >= 100:  # assigned shares → sell calls
            return Signal(ctx.symbol, SignalAction.ENTER_SHORT, asset_class=AssetClass.OPTION,
                          meta={"structure": "covered_call",
                                "target_delta": self.params.get("call_delta", 0.30),
                                "dte": self.params.get("dte", 30)})
        # flat → sell cash-secured put
        return Signal(ctx.symbol, SignalAction.ENTER_SHORT, asset_class=AssetClass.OPTION,
                      meta={"structure": "cash_secured_put",
                            "target_delta": self.params.get("put_delta", 0.30),
                            "dte": self.params.get("dte", 30)})


class IronCondorStrategy(StrategyBase):
    """Sell a defined-risk iron condor in high-IV, range-bound conditions."""

    key = "iron_condor"
    display_name = "Iron Condor"
    asset_classes = (AssetClass.OPTION,)
    param_schema = {
        "short_delta": {"type": "number", "default": 0.16},
        "wing_width": {"type": "number", "default": 5},
        "min_iv_rank": {"type": "number", "default": 40},
        "dte": {"type": "int", "default": 45},
    }

    def generate(self, ctx: StrategyContext) -> Signal:
        iv_rank = ctx.extras.get("iv_rank", 0)
        if ctx.extras.get("structure_open"):
            return Signal(ctx.symbol, SignalAction.HOLD)
        # Prefer range-bound: price near its mean.
        c = ctx.bars["close"]
        ranging = True
        if len(c) >= 20:
            mean = sma(c, 20).iloc[-1]
            ranging = abs(c.iloc[-1] - mean) / mean < Decimal("0.03") if mean else True
        if iv_rank >= self.params.get("min_iv_rank", 40) and ranging:
            return Signal(ctx.symbol, SignalAction.ENTER_SHORT, asset_class=AssetClass.OPTION,
                          meta={"structure": "iron_condor",
                                "short_delta": self.params.get("short_delta", 0.16),
                                "wing_width": self.params.get("wing_width", 5),
                                "dte": self.params.get("dte", 45)})
        return Signal(ctx.symbol, SignalAction.HOLD)
