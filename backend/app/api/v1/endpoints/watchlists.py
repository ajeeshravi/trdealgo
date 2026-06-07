"""User watchlists (named lists of internal symbols)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.platform import Watchlist

router = APIRouter(prefix="/watchlists", tags=["watchlists"])
ROLES_ALL = ("admin", "trader", "viewer")


class CreateWatchlistRequest(BaseModel):
    name: str
    description: str | None = None
    symbols: list[str] = []


class UpdateSymbolsRequest(BaseModel):
    symbols: list[str] = []


def _serialize(w: Watchlist) -> dict:
    return {
        "id": str(w.id),
        "name": w.name,
        "description": w.description,
        "symbols": w.symbols or [],
    }


async def _get_owned(db: AsyncSession, wid: str, user_id) -> Watchlist:
    w = await db.get(Watchlist, wid)
    if w is None or w.user_id != user_id:
        raise HTTPException(404, "watchlist not found")
    return w


@router.get("")
async def list_watchlists(
    current: CurrentUser = Depends(require_roles(*ROLES_ALL)),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(Watchlist)
            .where(Watchlist.user_id == current.user.id)
            .order_by(Watchlist.created_at.asc())
        )
    ).scalars().all()
    return [_serialize(w) for w in rows]


@router.post("", status_code=201)
async def create_watchlist(
    body: CreateWatchlistRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    w = Watchlist(
        user_id=current.user.id,
        name=body.name,
        description=body.description,
        symbols=body.symbols or [],
    )
    db.add(w)
    await db.flush()
    return _serialize(w)


@router.put("/{watchlist_id}/symbols")
async def update_symbols(
    watchlist_id: str,
    body: UpdateSymbolsRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    w = await _get_owned(db, watchlist_id, current.user.id)
    w.symbols = body.symbols or []
    await db.flush()
    return _serialize(w)


@router.delete("/{watchlist_id}")
async def delete_watchlist(
    watchlist_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    w = await _get_owned(db, watchlist_id, current.user.id)
    await db.delete(w)
    await db.flush()
    return {"ok": True}
