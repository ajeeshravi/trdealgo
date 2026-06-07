"""Resolve a market-data engine from a user's connected Alpaca account.

Credentials are entered in the frontend (Brokers page) and stored encrypted in
the DB — the platform uses those for market data (snapshot, bars, backtests,
the paper engine) so nothing needs to live in backend/.env. A vendor key in the
environment (Polygon / Alpaca) is still honoured as an optional fallback.
"""
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decrypt_secret
from app.market_data.engine import MarketDataEngine
from app.market_data.providers import AlpacaDataProvider, PolygonDataProvider
from app.models.trading import BrokerAccount

ALPACA_BROKERS = ("alpaca_paper", "alpaca")


def _env_engine() -> MarketDataEngine | None:
    if settings.POLYGON_API_KEY:
        return MarketDataEngine(PolygonDataProvider())
    if settings.ALPACA_API_KEY:
        return MarketDataEngine(AlpacaDataProvider())
    return None


async def data_engine_for_user(db: AsyncSession, user_id) -> MarketDataEngine | None:
    """Prefer the user's connected Alpaca account creds; fall back to env vendor.

    Returns None when no data source is available, so callers can degrade
    gracefully (empty snapshot rows / a clear "connect an account" message).
    """
    row = (
        await db.execute(
            select(BrokerAccount)
            .where(
                BrokerAccount.user_id == user_id,
                BrokerAccount.broker.in_(ALPACA_BROKERS),
                BrokerAccount.is_active.is_(True),
            )
            .order_by(BrokerAccount.created_at.desc())
        )
    ).scalars().first()
    if row is not None and row.credentials_enc:
        try:
            creds = json.loads(decrypt_secret(row.credentials_enc))
            if creds.get("api_key") and creds.get("api_secret"):
                return MarketDataEngine(
                    AlpacaDataProvider(creds["api_key"], creds["api_secret"])
                )
        except Exception:  # noqa: BLE001 - fall through to env fallback
            pass
    return _env_engine()
