"""Futures contract specs, rollover management, and futures-specific risk."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

# Month codes per CME convention.
MONTH_CODES = {3: "H", 6: "M", 9: "U", 12: "Z"}  # quarterly cycle (index futures)
ALL_MONTH_CODES = {1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
                   7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z"}


@dataclass(slots=True)
class ContractSpec:
    root: str
    name: str
    exchange: str
    multiplier: Decimal       # $ per point
    tick_size: Decimal
    tick_value: Decimal
    initial_margin: Decimal
    maintenance_margin: Decimal
    quarterly: bool = True    # index futures roll quarterly


# A representative subset; extend as needed.
SPECS: dict[str, ContractSpec] = {
    "ES": ContractSpec("ES", "E-mini S&P 500", "CME", Decimal(50), Decimal("0.25"),
                       Decimal("12.50"), Decimal(13200), Decimal(12000)),
    "MES": ContractSpec("MES", "Micro E-mini S&P 500", "CME", Decimal(5), Decimal("0.25"),
                        Decimal("1.25"), Decimal(1320), Decimal(1200)),
    "NQ": ContractSpec("NQ", "E-mini Nasdaq 100", "CME", Decimal(20), Decimal("0.25"),
                       Decimal("5.00"), Decimal(17600), Decimal(16000)),
    "MNQ": ContractSpec("MNQ", "Micro E-mini Nasdaq 100", "CME", Decimal(2), Decimal("0.25"),
                        Decimal("0.50"), Decimal(1760), Decimal(1600)),
    "CL": ContractSpec("CL", "Crude Oil", "NYMEX", Decimal(1000), Decimal("0.01"),
                       Decimal("10.00"), Decimal(6000), Decimal(5500), quarterly=False),
    "GC": ContractSpec("GC", "Gold", "COMEX", Decimal(100), Decimal("0.10"),
                       Decimal("10.00"), Decimal(11000), Decimal(10000), quarterly=False),
}


def front_month_symbol(root: str, today: date | None = None) -> str:
    today = today or date.today()
    spec = SPECS[root]
    codes = MONTH_CODES if spec.quarterly else ALL_MONTH_CODES
    for m in sorted(codes):
        if m >= today.month:
            return f"{root}{codes[m]}{today.year % 100}"
    # roll to next year's first contract
    first = sorted(codes)[0]
    return f"{root}{codes[first]}{(today.year + 1) % 100}"


@dataclass(slots=True)
class RolloverDecision:
    should_roll: bool
    from_contract: str
    to_contract: str
    reason: str


def evaluate_rollover(
    root: str, expiry: date, *, days_before: int = 5, today: date | None = None
) -> RolloverDecision:
    """Roll N days before expiry to avoid delivery/illiquidity."""
    today = today or date.today()
    current = front_month_symbol(root, today)
    roll = today >= expiry - timedelta(days=days_before)
    return RolloverDecision(
        should_roll=roll,
        from_contract=current,
        to_contract=front_month_symbol(root, expiry + timedelta(days=1)),
        reason=f"within {days_before}d of expiry" if roll else "holding front month",
    )


def required_margin(root: str, contracts: int) -> Decimal:
    return SPECS[root].initial_margin * contracts
