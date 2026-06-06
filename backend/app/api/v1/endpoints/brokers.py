"""Broker account management: list capabilities, link, connect, portfolio."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.brokers.factory import CAPABILITIES, supported_brokers
from app.core.database import get_db
from app.core.security import encrypt_secret
from app.models.trading import BrokerAccount
from app.services.broker_manager import broker_manager

router = APIRouter(tags=["brokers"])


class LinkBrokerRequest(BaseModel):
    broker: str
    alias: str | None = None
    paper: bool = True
    credentials: dict  # e.g. {"api_key": "...", "api_secret": "..."}


@router.get("/brokers")
async def list_brokers(current: CurrentUser = Depends(require_roles("admin", "trader", "viewer"))):
    return {"supported": supported_brokers(), "capabilities": CAPABILITIES}


@router.post("/broker-accounts", status_code=201)
async def link_account(
    body: LinkBrokerRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    if body.broker not in supported_brokers():
        raise HTTPException(400, f"unsupported broker: {body.broker}")
    account = BrokerAccount(
        user_id=current.user.id,
        broker=body.broker,
        alias=body.alias,
        paper=body.paper,
        credentials_enc=encrypt_secret(json.dumps(body.credentials)),
    )
    db.add(account)
    await db.flush()
    return {"id": str(account.id), "broker": account.broker, "status": account.status}


@router.post("/broker-accounts/{account_id}/connect")
async def connect_account(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    broker = await broker_manager.get(db, account_id)
    account = await db.get(BrokerAccount, account_id)
    account.status = "connected"
    acct = await broker.get_account()
    return {"status": "connected", "equity": str(acct.equity),
            "buying_power": str(acct.buying_power)}


@router.get("/broker-accounts/{account_id}/positions")
async def get_positions(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    broker = await broker_manager.get(db, account_id)
    positions = await broker.get_positions()
    return [
        {"symbol": p.symbol, "asset_class": p.asset_class.value, "qty": str(p.qty),
         "avg_price": str(p.avg_price), "market_price": str(p.market_price or ""),
         "unrealized_pnl": str(p.unrealized_pnl or "")}
        for p in positions
    ]


@router.get("/broker-accounts")
async def list_accounts(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(BrokerAccount).where(BrokerAccount.user_id == current.user.id)
        )
    ).scalars().all()
    return [
        {"id": str(a.id), "broker": a.broker, "alias": a.alias,
         "paper": a.paper, "status": a.status}
        for a in rows
    ]
