"""User-facing positions, fetched live from the user's connected brokers.

Open positions come straight from each broker. Alpaca's positions API is
open-only, so closed positions (``include_closed=true``) are reconstructed from
filled order history: a symbol whose filled buys and sells net to zero is a
completed round-trip, with realized P&L = sell proceeds − buy cost.
"""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.brokers.models import OrderSide, OrderStatus
from app.core.database import get_db
from app.core.logging import get_logger
from app.models.trading import BrokerAccount
from app.services.broker_manager import broker_manager

router = APIRouter(prefix="/positions", tags=["positions"])
log = get_logger("positions")


def _num(v) -> float:
    return float(v) if v is not None else 0.0


def closed_positions_from_orders(orders: list) -> list[dict]:
    """Reconstruct fully round-tripped (net-zero) positions from filled orders.

    Returns a list of ``{symbol, qty(0), avg_price, realized_pnl}`` for symbols
    whose filled buy qty equals filled sell qty (a completed long round-trip).
    Partially-closed symbols stay open and are reported by the broker directly.
    """
    agg: dict[str, dict[str, float]] = defaultdict(
        lambda: {"buy_qty": 0.0, "buy_val": 0.0, "sell_qty": 0.0, "sell_val": 0.0}
    )
    for o in orders:
        if o.status is not OrderStatus.FILLED:
            continue
        qty = _num(o.filled_qty) or _num(o.qty)
        price = _num(o.avg_fill_price)
        if qty <= 0 or price <= 0:
            continue
        a = agg[o.symbol]
        if o.side is OrderSide.BUY:
            a["buy_qty"] += qty
            a["buy_val"] += qty * price
        elif o.side is OrderSide.SELL:
            a["sell_qty"] += qty
            a["sell_val"] += qty * price

    out: list[dict] = []
    for symbol, a in agg.items():
        # fully closed long round-trip
        if a["buy_qty"] > 0 and abs(a["buy_qty"] - a["sell_qty"]) < 1e-9:
            avg = a["buy_val"] / a["buy_qty"]
            out.append(
                {
                    "symbol": symbol,
                    "avg_price": avg,
                    "realized_pnl": a["sell_val"] - a["buy_val"],
                }
            )
    return out


@router.get("")
async def list_positions(
    include_closed: bool = False,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    accounts = (
        await db.execute(
            select(BrokerAccount).where(
                BrokerAccount.user_id == current.user.id,
                BrokerAccount.is_active.is_(True),
            )
        )
    ).scalars().all()

    out: list[dict] = []
    for acc in accounts:
        try:
            broker = await broker_manager.get(db, str(acc.id))
            positions = await broker.get_positions()
        except Exception as exc:  # noqa: BLE001 - one bad broker shouldn't 500 the page
            log.warning("positions.broker_failed", account_id=str(acc.id), error=str(exc))
            continue

        open_symbols = set()
        for p in positions:
            qty = _num(p.qty)
            open_symbols.add(p.symbol)
            if qty == 0:
                continue
            segment = p.asset_class.value if hasattr(p.asset_class, "value") else str(p.asset_class)
            out.append(
                {
                    "id": f"{acc.id}:{p.symbol}",
                    "broker_account_id": str(acc.id),
                    "strategy_run_id": None,
                    "strategy_id": None,
                    "strategy_name": None,
                    "internal_symbol": p.symbol,
                    "trading_symbol": p.symbol,
                    "product": "DAY",
                    "segment": segment,
                    "qty": qty,
                    "avg_price": _num(p.avg_price),
                    "last_price": _num(p.market_price) if p.market_price is not None else None,
                    "realized_pnl": 0.0,
                    "unrealized_pnl": _num(p.unrealized_pnl),
                }
            )

        if not include_closed:
            continue
        try:
            orders = await broker.get_orders(open_only=False)
        except Exception as exc:  # noqa: BLE001
            log.warning("positions.orders_failed", account_id=str(acc.id), error=str(exc))
            continue
        for c in closed_positions_from_orders(orders):
            if c["symbol"] in open_symbols:
                continue  # still has an open leg; not fully closed
            out.append(
                {
                    "id": f"{acc.id}:{c['symbol']}:closed",
                    "broker_account_id": str(acc.id),
                    "strategy_run_id": None,
                    "strategy_id": None,
                    "strategy_name": None,
                    "internal_symbol": c["symbol"],
                    "trading_symbol": c["symbol"],
                    "product": "DAY",
                    "segment": "stock",
                    "qty": 0.0,
                    "avg_price": c["avg_price"],
                    "last_price": None,
                    "realized_pnl": c["realized_pnl"],
                    "unrealized_pnl": 0.0,
                }
            )
    return out
