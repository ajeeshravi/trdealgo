"""Symbol search / resolution.

This build has no seeded symbol master yet, so for US equities we synthesize a
row directly from the typed ticker — that makes any US symbol searchable and
addable to watchlists/strategies. Options-chain routes (expiries/strikes)
return empty until a US options master is wired up (a later phase).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user

router = APIRouter(prefix="/symbols", tags=["symbols"])


def _equity_row(ticker: str) -> dict:
    t = ticker.strip().upper()
    return {
        "internal_symbol": t,
        "trading_symbol": t,
        "underlying": t,
        "segment": "EQUITY",
        "exchange": "US",
        "expiry": None,
        "strike": None,
        "option_type": None,
        "lot_size": 1,
        "tick_size": 0.01,
    }


# --- Static routes first so they aren't shadowed by /{symbol} ---------------
@router.get("/filters")
async def filters(current: CurrentUser = Depends(get_current_user)):
    return {
        "exchanges": ["US"],
        "segments": ["EQUITY", "OPTION"],
        "option_types": ["CALL", "PUT"],
        "total": 0,
    }


@router.get("/search")
async def search(
    q: str = "",
    limit: int = 25,
    exchange: str | None = None,
    segment: str | None = None,
    underlying: str | None = None,
    current: CurrentUser = Depends(get_current_user),
):
    q = (q or "").strip()
    if len(q) < 1:
        return []
    # Equity passthrough: surface the typed ticker as a usable symbol.
    if not segment or segment.upper() == "EQUITY":
        return [_equity_row(q)]
    return []


@router.get("/underlyings")
async def underlyings(
    exchange: str | None = None,
    q: str = "",
    limit: int = 30,
    current: CurrentUser = Depends(get_current_user),
):
    q = (q or "").strip().upper()
    return [q] if q else []


class ResolveRequest(BaseModel):
    exchange: str | None = None
    underlying: str
    limit: int = 25
    expiry: str | None = None
    segment: str | None = None
    option_type: str | None = None
    strike: float | None = None


@router.post("/resolve")
async def resolve(body: ResolveRequest, current: CurrentUser = Depends(get_current_user)):
    if not body.segment or body.segment.upper() == "EQUITY":
        row = _equity_row(body.underlying)
        return {
            "exact": True,
            "matches": [
                {
                    "internal_symbol": row["internal_symbol"],
                    "trading_symbol": row["trading_symbol"],
                    "exchange": row["exchange"],
                    "segment": row["segment"],
                    "underlying": row["underlying"],
                }
            ],
        }
    return {"exact": False, "matches": []}


class ResolveAliasRequest(BaseModel):
    exchange: str | None = None
    underlying: str
    alias: str


@router.post("/resolve-alias")
async def resolve_alias(
    body: ResolveAliasRequest, current: CurrentUser = Depends(get_current_user)
):
    # Logical futures aliases need an options/futures master; not available yet.
    return {
        "logical_symbol": f"{body.underlying}_@{body.alias}_FUT",
        "internal_symbol": None,
        "alias": body.alias,
        "expiry": None,
        "days_to_expiry": None,
        "error": "No futures master configured for US symbols yet.",
    }


# --- Dynamic per-underlying option routes (empty until options master) ------
@router.get("/{underlying}/expiries")
async def expiries(underlying: str, current: CurrentUser = Depends(get_current_user)):
    return []


@router.get("/{underlying}/option-types")
async def option_types(
    underlying: str, expiry: str | None = None, current: CurrentUser = Depends(get_current_user)
):
    return []


@router.get("/{underlying}/strikes")
async def strikes(
    underlying: str,
    expiry: str | None = None,
    option_type: str | None = None,
    current: CurrentUser = Depends(get_current_user),
):
    return []


@router.get("/by-internal/{internal}/brokers")
async def brokers_for_symbol(internal: str, current: CurrentUser = Depends(get_current_user)):
    return []


@router.get("/{symbol}")
async def symbol_detail(symbol: str, current: CurrentUser = Depends(get_current_user)):
    return _equity_row(symbol)
