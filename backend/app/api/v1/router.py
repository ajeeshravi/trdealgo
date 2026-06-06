"""Aggregate v1 API router."""
from fastapi import APIRouter

from app.api.v1.endpoints import ai, auth, brokers, market_data, orders, risk, strategies

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(brokers.router)
api_router.include_router(orders.router)
api_router.include_router(risk.router)
api_router.include_router(strategies.router)
api_router.include_router(market_data.router)
api_router.include_router(ai.router)
