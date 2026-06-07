"""User-facing positions, fetched live from the user's connected brokers."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.core.logging import get_logger
from app.models.trading import BrokerAccount
from app.services.broker_manager import broker_manager

router = APIRouter(prefix="/positions", tags=["positions"])
log = get_logger("positions")


def _num(v) -> float:
    return float(v) if v is not None else 0.0


@router.get("")
async def list_positions(
    include_closed: bool = False,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    """Live positions across the user's active broker accounts.

    Pulls from each connected broker (Alpaca/IBKR) rather than a local table, so
    positions opened directly at the broker show up. Brokers that can't be
    reached are skipped (logged) rather than failing the whole request.
    """
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
        for p in positions:
            qty = _num(p.qty)
            if not include_closed and qty == 0:
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
    return out
