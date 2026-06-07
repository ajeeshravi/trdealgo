"""User-facing positions across all of the user's broker accounts."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.trading import BrokerAccount, Position

router = APIRouter(prefix="/positions", tags=["positions"])


def _num(v) -> float:
    return float(v) if v is not None else 0.0


@router.get("")
async def list_positions(
    include_closed: bool = False,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    # Only the current user's accounts.
    account_ids = (
        await db.execute(
            select(BrokerAccount.id).where(BrokerAccount.user_id == current.user.id)
        )
    ).scalars().all()
    if not account_ids:
        return []

    stmt = select(Position).where(Position.account_id.in_(account_ids))
    rows = (await db.execute(stmt)).scalars().all()

    out = []
    for p in rows:
        qty = _num(p.qty)
        if not include_closed and qty == 0:
            continue
        out.append(
            {
                "id": str(p.id),
                "broker_account_id": str(p.account_id),
                "strategy_run_id": None,
                "strategy_id": None,
                "strategy_name": None,
                "internal_symbol": p.symbol,
                "trading_symbol": p.symbol,
                "product": "DAY",
                "segment": p.asset_class,
                "qty": qty,
                "avg_price": _num(p.avg_price),
                "last_price": _num(p.market_price) if p.market_price is not None else None,
                "realized_pnl": 0.0,
                "unrealized_pnl": _num(p.unrealized_pnl),
            }
        )
    return out
