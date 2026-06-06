"""Position manager: reconciles broker positions and computes real-time P&L.

Keeps an in-memory/Redis-backed view that the risk monitors and WS gateway read,
and updates peak-equity and realized-PnL counters used by the risk engine.
"""
from __future__ import annotations

from decimal import Decimal

from app.brokers.base import BrokerBase
from app.core.redis import get_redis


class PositionManager:
    def __init__(self, broker: BrokerBase, account_id: str) -> None:
        self.broker = broker
        self.account_id = account_id

    async def reconcile(self) -> dict:
        """Pull authoritative state from the broker and refresh derived metrics."""
        account = await self.broker.get_account()
        positions = await self.broker.get_positions()
        r = get_redis()

        unrealized = sum(
            (p.unrealized_pnl or Decimal(0) for p in positions), Decimal(0)
        )
        # Track peak equity for drawdown checks.
        peak = await r.get(f"equity:peak:{self.account_id}")
        peak_val = max(Decimal(peak) if peak else account.equity, account.equity)
        await r.set(f"equity:peak:{self.account_id}", str(peak_val))
        await r.set(f"pnl:unrealized:{self.account_id}", str(unrealized))

        return {
            "equity": account.equity,
            "cash": account.cash,
            "buying_power": account.buying_power,
            "unrealized_pnl": unrealized,
            "positions": [
                {
                    "symbol": p.symbol,
                    "qty": p.qty,
                    "avg_price": p.avg_price,
                    "market_price": p.market_price,
                    "unrealized_pnl": p.unrealized_pnl,
                }
                for p in positions
            ],
        }

    async def record_realized(self, pnl: Decimal) -> None:
        r = get_redis()
        await r.incrbyfloat(f"pnl:realized:{self.account_id}", float(pnl))
