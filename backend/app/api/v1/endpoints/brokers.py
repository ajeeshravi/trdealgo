"""Broker account management.

Contract consumed by the frontend `/brokers` page:

* ``GET  /brokers/types``            – broker definitions (form fields, auth kind)
* ``GET  /brokers``                  – the current user's linked accounts
* ``GET  /brokers/{id}``             – a single account (``?include_secrets=true``
                                       returns decrypted, non-secret creds + has-flags)
* ``GET  /brokers/by-broker/{key}``  – accounts filtered by broker key (OAuth callback)
* ``POST /brokers``                  – link a new account
* ``PATCH /brokers/{id}``            – update label / active / client_id / credentials
* ``POST /brokers/{id}/login``       – verify / refresh the broker session
* ``POST /brokers/{id}/logout``      – drop the live session
* ``GET  /brokers/{id}/auth-url``    – OAuth redirect URL (only for oauth_daily brokers)
* ``DELETE /brokers/{id}``           – remove the account

US brokers (Alpaca, IBKR) authenticate with long-lived API credentials rather
than a daily OAuth dance, so ``login`` here means "open a session and validate
the credentials by fetching the account".
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.brokers.factory import supported_brokers
from app.core.database import get_db
from app.core.security import decrypt_secret, encrypt_secret
from app.models.trading import BrokerAccount
from app.services.broker_manager import broker_manager

router = APIRouter(tags=["brokers"])


# ---------------------------------------------------------------------------
# Broker definitions (drives the Add/Edit/Login forms in the UI)
# ---------------------------------------------------------------------------
# `secret` fields are never returned in plaintext on the list endpoints; the
# edit dialog fetches non-secret values via ?include_secrets=true and shows a
# "(stored)" hint for secret ones.
_ALPACA_SETUP_FIELDS = [
    {
        "name": "api_key",
        "label": "API Key ID",
        "type": "text",
        "required": True,
        "placeholder": "PK… / AK…",
        "secret": True,
    },
    {
        "name": "api_secret",
        "label": "API Secret Key",
        "type": "password",
        "required": True,
        "secret": True,
    },
]

BROKER_TYPES: list[dict] = [
    {
        "broker": "alpaca_paper",
        "display_name": "Alpaca — Paper Trading",
        "summary": "Risk-free paper trading + market data. Use your Alpaca PAPER API keys.",
        "auth_kind": "long_lived_token",
        "setup_fields": _ALPACA_SETUP_FIELDS,
        "daily_login_fields": [],
        "oauth_url_template": None,
        "docs_url": "https://docs.alpaca.markets/docs/paper-trading",
        "notes": [
            "Generate PAPER keys from the Alpaca dashboard (paper keys start with PK).",
            "These keys also power live prices and backtests across the app.",
        ],
    },
    {
        "broker": "alpaca",
        "display_name": "Alpaca — Live",
        "summary": "Commission-free US stocks, ETFs and options via REST API keys.",
        "auth_kind": "long_lived_token",
        "setup_fields": _ALPACA_SETUP_FIELDS,
        "daily_login_fields": [],
        "oauth_url_template": None,
        "docs_url": "https://docs.alpaca.markets/",
        "notes": [
            "Use your LIVE Alpaca keys (they start with AK).",
            "For risk-free testing, choose Alpaca — Paper Trading instead.",
        ],
    },
    {
        "broker": "ibkr",
        "display_name": "Interactive Brokers",
        "summary": "US & global markets via a running TWS or IB Gateway connection.",
        "auth_kind": "long_lived_token",
        "setup_fields": [
            {
                "name": "host",
                "label": "Gateway Host",
                "type": "text",
                "required": True,
                "placeholder": "127.0.0.1",
                "help": "Host where TWS / IB Gateway is reachable.",
                "secret": False,
            },
            {
                "name": "port",
                "label": "Gateway Port",
                "type": "number",
                "required": True,
                "placeholder": "7497",
                "help": "7497 paper / 7496 live (TWS), 4002 / 4001 (Gateway).",
                "secret": False,
            },
            {
                "name": "client_id",
                "label": "Client ID",
                "type": "number",
                "required": False,
                "placeholder": "1",
                "secret": False,
            },
        ],
        "daily_login_fields": [],
        "oauth_url_template": None,
        "docs_url": "https://www.interactivebrokers.com/en/trading/ib-api.php",
        "notes": [
            "Requires a running TWS or IB Gateway with API access enabled.",
        ],
    },
]

_TYPE_BY_KEY = {t["broker"]: t for t in BROKER_TYPES}


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------
class LinkBrokerRequest(BaseModel):
    broker: str
    client_id: str | None = None
    label: str | None = None
    is_paper: bool = False
    credentials: dict = {}


class UpdateBrokerRequest(BaseModel):
    client_id: str | None = None
    label: str | None = None
    is_active: bool | None = None
    is_paper: bool | None = None
    credentials: dict | None = None


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------
def _secret_names(broker: str) -> set[str]:
    t = _TYPE_BY_KEY.get(broker)
    if not t:
        return set()
    return {f["name"] for f in t["setup_fields"] if f.get("secret")}


def _public_credentials(account: BrokerAccount, *, include_secrets: bool) -> dict:
    """Non-secret credential values + ``_has_<name>`` flags for secret ones.

    Never leaks decrypted secrets. ``include_secrets`` only widens the set of
    *non-secret* fields returned (the edit form needs them pre-filled); secret
    fields are always represented purely by their ``_has_<name>`` flag.
    """
    try:
        creds = json.loads(decrypt_secret(account.credentials_enc)) if account.credentials_enc else {}
    except Exception:
        creds = {}
    secrets = _secret_names(account.broker)
    out: dict = {}
    for name, value in creds.items():
        if name in secrets:
            out[f"_has_{name}"] = bool(value)
        elif include_secrets:
            out[name] = value
    return out


def _serialize(account: BrokerAccount, *, include_secrets: bool = False) -> dict:
    return {
        "id": str(account.id),
        "broker": account.broker,
        "client_id": account.client_id or account.alias or "",
        "label": account.label,
        "is_active": account.is_active,
        "is_paper": account.paper,
        "session_valid_until": account.session_valid_until.isoformat()
        if account.session_valid_until
        else None,
        "last_login_at": account.last_login_at.isoformat() if account.last_login_at else None,
        "last_error": account.last_error,
        "credentials_public": _public_credentials(account, include_secrets=include_secrets),
    }


async def _get_owned(db: AsyncSession, account_id: str, user_id) -> BrokerAccount:
    account = await db.get(BrokerAccount, account_id)
    if account is None or account.user_id != user_id:
        raise HTTPException(404, "broker account not found")
    return account


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/brokers/types")
async def list_broker_types(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
):
    return BROKER_TYPES


@router.get("/brokers")
async def list_accounts(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(BrokerAccount).where(BrokerAccount.user_id == current.user.id)
        )
    ).scalars().all()
    return [_serialize(a) for a in rows]


@router.get("/brokers/by-broker/{broker_key}")
async def list_accounts_by_broker(
    broker_key: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(BrokerAccount).where(
                BrokerAccount.user_id == current.user.id,
                BrokerAccount.broker == broker_key,
            )
        )
    ).scalars().all()
    return [_serialize(a) for a in rows]


@router.get("/brokers/{account_id}")
async def get_account(
    account_id: str,
    include_secrets: bool = False,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_owned(db, account_id, current.user.id)
    return _serialize(account, include_secrets=include_secrets)


@router.post("/brokers", status_code=201)
async def link_account(
    body: LinkBrokerRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    if body.broker not in supported_brokers():
        raise HTTPException(400, f"unsupported broker: {body.broker}")
    # A "*_paper" broker type is always a paper account regardless of the form's
    # is_paper flag (the form leaves it false; the broker type is explicit).
    is_paper = body.is_paper or body.broker.endswith("_paper")
    account = BrokerAccount(
        user_id=current.user.id,
        broker=body.broker,
        client_id=body.client_id,
        label=body.label,
        alias=body.label,
        paper=is_paper,
        is_active=True,
        credentials_enc=encrypt_secret(json.dumps(body.credentials or {})),
    )
    db.add(account)
    await db.flush()
    return _serialize(account)


@router.patch("/brokers/{account_id}")
async def update_account(
    account_id: str,
    body: UpdateBrokerRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_owned(db, account_id, current.user.id)
    if body.client_id is not None:
        account.client_id = body.client_id
    if body.label is not None:
        account.label = body.label
        account.alias = body.label
    if body.is_active is not None:
        account.is_active = body.is_active
    if body.is_paper is not None:
        account.paper = body.is_paper
    if body.credentials:
        # Merge: keep existing values for keys the form left blank (secrets).
        try:
            existing = json.loads(decrypt_secret(account.credentials_enc)) if account.credentials_enc else {}
        except Exception:
            existing = {}
        existing.update(body.credentials)
        account.credentials_enc = encrypt_secret(json.dumps(existing))
    await db.flush()
    return _serialize(account)


@router.post("/brokers/{account_id}/login")
async def login_account(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_owned(db, account_id, current.user.id)
    try:
        broker = await broker_manager.get(db, account_id)
        await broker.get_account()
    except Exception as exc:  # noqa: BLE001 - surface the broker error to the UI
        account.last_error = str(exc)[:500]
        account.status = "error"
        await db.flush()
        raise HTTPException(502, f"broker login failed: {exc}") from exc
    now = datetime.now(UTC)
    account.status = "connected"
    account.last_login_at = now
    account.session_valid_until = now + timedelta(hours=12)
    account.last_error = None
    await db.flush()
    return _serialize(account)


@router.post("/brokers/{account_id}/logout")
async def logout_account(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_owned(db, account_id, current.user.id)
    await broker_manager.disconnect(account_id)
    account.status = "disconnected"
    account.session_valid_until = None
    await db.flush()
    return _serialize(account)


@router.get("/brokers/{account_id}/auth-url")
async def broker_auth_url(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_owned(db, account_id, current.user.id)
    t = _TYPE_BY_KEY.get(account.broker)
    template = (t or {}).get("oauth_url_template")
    if not template:
        raise HTTPException(
            400,
            f"{account.broker} uses API-key auth — use Login/Verify, not OAuth.",
        )
    return {"url": template.format(state=str(account.id))}


@router.delete("/brokers/{account_id}", status_code=204)
async def delete_account(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    account = await _get_owned(db, account_id, current.user.id)
    await broker_manager.disconnect(account_id)
    await db.delete(account)
    await db.flush()


# ---------------------------------------------------------------------------
# Portfolio (kept from the original API; used by positions/strategy code)
# ---------------------------------------------------------------------------
@router.get("/brokers/{account_id}/positions")
async def get_positions(
    account_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    await _get_owned(db, account_id, current.user.id)
    broker = await broker_manager.get(db, account_id)
    positions = await broker.get_positions()
    return [
        {"symbol": p.symbol, "asset_class": p.asset_class.value, "qty": str(p.qty),
         "avg_price": str(p.avg_price), "market_price": str(p.market_price or ""),
         "unrealized_pnl": str(p.unrealized_pnl or "")}
        for p in positions
    ]
