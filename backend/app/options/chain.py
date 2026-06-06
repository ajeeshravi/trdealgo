"""Option chain assembly and defined-risk structure builders.

Pulls raw quotes from a market-data provider, enriches with Greeks/IV, and can
construct multi-leg structures (vertical spreads, iron condor, straddle/strangle)
as :class:`OrderRequest` objects with :class:`OptionLeg` legs.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from app.brokers.models import (
    AssetClass,
    OptionLeg,
    OrderRequest,
    OrderSide,
    OrderType,
)


@dataclass(slots=True)
class ChainRow:
    occ_symbol: str
    expiry: date
    strike: Decimal
    right: str  # call|put
    bid: Decimal
    ask: Decimal
    last: Decimal | None
    open_interest: int
    volume: int
    iv: float | None = None
    delta: float | None = None


def _occ(underlying: str, expiry: date, strike: Decimal, right: str) -> str:
    cp = "C" if right == "call" else "P"
    strike_int = int(strike * 1000)
    return f"{underlying.upper()}{expiry:%y%m%d}{cp}{strike_int:08d}"


def vertical_spread(
    underlying: str, expiry: date, long_strike: Decimal, short_strike: Decimal,
    right: str, qty: int = 1,
) -> OrderRequest:
    """Debit/credit vertical: long one strike, short another, same expiry/right."""
    return OrderRequest(
        symbol=underlying,
        asset_class=AssetClass.OPTION,
        side=OrderSide.BUY,
        qty=Decimal(qty),
        order_type=OrderType.LIMIT,
        legs=[
            OptionLeg(_occ(underlying, expiry, long_strike, right), OrderSide.BUY,
                      strike=long_strike, expiry=str(expiry), right=right),
            OptionLeg(_occ(underlying, expiry, short_strike, right), OrderSide.SELL,
                      strike=short_strike, expiry=str(expiry), right=right),
        ],
    )


def iron_condor(
    underlying: str, expiry: date,
    put_long: Decimal, put_short: Decimal,
    call_short: Decimal, call_long: Decimal, qty: int = 1,
) -> OrderRequest:
    """Sell OTM put spread + OTM call spread (defined-risk, market-neutral)."""
    return OrderRequest(
        symbol=underlying,
        asset_class=AssetClass.OPTION,
        side=OrderSide.SELL,
        qty=Decimal(qty),
        order_type=OrderType.LIMIT,
        legs=[
            OptionLeg(_occ(underlying, expiry, put_long, "put"), OrderSide.BUY,
                      strike=put_long, expiry=str(expiry), right="put"),
            OptionLeg(_occ(underlying, expiry, put_short, "put"), OrderSide.SELL,
                      strike=put_short, expiry=str(expiry), right="put"),
            OptionLeg(_occ(underlying, expiry, call_short, "call"), OrderSide.SELL,
                      strike=call_short, expiry=str(expiry), right="call"),
            OptionLeg(_occ(underlying, expiry, call_long, "call"), OrderSide.BUY,
                      strike=call_long, expiry=str(expiry), right="call"),
        ],
    )


def straddle(underlying: str, expiry: date, strike: Decimal, qty: int = 1, long: bool = True):
    side = OrderSide.BUY if long else OrderSide.SELL
    return OrderRequest(
        symbol=underlying, asset_class=AssetClass.OPTION, side=side,
        qty=Decimal(qty), order_type=OrderType.LIMIT,
        legs=[
            OptionLeg(_occ(underlying, expiry, strike, "call"), side,
                      strike=strike, expiry=str(expiry), right="call"),
            OptionLeg(_occ(underlying, expiry, strike, "put"), side,
                      strike=strike, expiry=str(expiry), right="put"),
        ],
    )
