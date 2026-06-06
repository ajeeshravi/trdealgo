"""AI advisory endpoints. Output is informational and never bypasses risk."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.ai import analysis
from app.api.deps import CurrentUser, require_roles

router = APIRouter(prefix="/ai", tags=["ai"])


class SymbolsRequest(BaseModel):
    symbols: list[str]
    provider: str | None = None


class NewsRequest(BaseModel):
    headlines: list[str]
    provider: str | None = None


class TextRequest(BaseModel):
    text: str
    provider: str | None = None


@router.post("/sentiment")
async def sentiment(body: SymbolsRequest, current: CurrentUser = Depends(require_roles("admin", "trader"))):
    from app.ai.provider import get_provider

    return await analysis.market_sentiment(body.symbols, get_provider(body.provider))


@router.post("/news")
async def news(body: NewsRequest, current: CurrentUser = Depends(require_roles("admin", "trader"))):
    from app.ai.provider import get_provider

    return await analysis.analyze_news(body.headlines, get_provider(body.provider))


@router.post("/risk-assessment")
async def risk_assessment(body: TextRequest, current: CurrentUser = Depends(require_roles("admin", "trader"))):
    from app.ai.provider import get_provider

    return await analysis.assess_risk(body.text, get_provider(body.provider))
