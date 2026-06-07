"""Aggregate v1 API router."""
from fastapi import APIRouter

from app.api.v1.endpoints import (
    admin,
    ai,
    analytics,
    auth,
    backtests,
    brokers,
    market,
    market_data,
    notifications,
    orders,
    positions,
    risk,
    strategies,
    symbols,
    triggers,
    watchlists,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(brokers.router)
api_router.include_router(orders.router)
api_router.include_router(positions.router)
api_router.include_router(risk.router)
api_router.include_router(strategies.router)
api_router.include_router(triggers.router)
api_router.include_router(backtests.router)
api_router.include_router(market.router)
api_router.include_router(market_data.router)
api_router.include_router(watchlists.router)
api_router.include_router(symbols.router)
api_router.include_router(analytics.router)
api_router.include_router(notifications.router)
api_router.include_router(admin.router)
api_router.include_router(ai.router)
