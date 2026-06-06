"""AI-assisted (advisory) analysis: sentiment, news, earnings, opportunities, risk.

All functions return structured, advisory output. They never trigger trades.
"""
from __future__ import annotations

from app.ai.provider import AIProvider, _json_complete, get_provider

_DISCLAIMER = (
    "You are a financial analysis assistant for an automated trading platform. "
    "Provide objective, advisory-only analysis. You must NOT recommend bypassing "
    "risk controls. Output is informational, not investment advice."
)


async def market_sentiment(symbols: list[str], provider: AIProvider | None = None) -> dict:
    provider = provider or get_provider()
    prompt = (
        f"Assess current market sentiment for: {', '.join(symbols)}. "
        "Return JSON: {symbol: {sentiment: bullish|neutral|bearish, "
        "score: -1..1, rationale: str}}."
    )
    return await _json_complete(provider, _DISCLAIMER, prompt)


async def analyze_news(headlines: list[str], provider: AIProvider | None = None) -> dict:
    provider = provider or get_provider()
    prompt = (
        "Summarize and assess market impact of these headlines. Return JSON: "
        "{summary: str, impact: positive|neutral|negative, "
        "key_risks: [str], affected_symbols: [str]}.\n\n"
        + "\n".join(f"- {h}" for h in headlines)
    )
    return await _json_complete(provider, _DISCLAIMER, prompt)


async def analyze_earnings(symbol: str, report: str, provider: AIProvider | None = None) -> dict:
    provider = provider or get_provider()
    prompt = (
        f"Analyze this earnings report for {symbol}. Return JSON: "
        "{beat_miss: beat|inline|miss, guidance: str, "
        "expected_reaction: str, confidence: 0..1}.\n\n" + report
    )
    return await _json_complete(provider, _DISCLAIMER, prompt)


async def detect_opportunities(market_summary: str, provider: AIProvider | None = None) -> dict:
    provider = provider or get_provider()
    prompt = (
        "Given this market context, identify potential trade ideas (advisory). "
        "Return JSON: {ideas: [{symbol, thesis, direction, risk_note}]}. "
        "These are suggestions only and remain subject to platform risk controls."
        "\n\n" + market_summary
    )
    return await _json_complete(provider, _DISCLAIMER, prompt)


async def assess_risk(portfolio_summary: str, provider: AIProvider | None = None) -> dict:
    provider = provider or get_provider()
    prompt = (
        "Provide a narrative risk assessment of this portfolio. Return JSON: "
        "{concentration_risk: str, correlation_risk: str, "
        "tail_risk: str, overall: low|medium|high}.\n\n" + portfolio_summary
    )
    return await _json_complete(provider, _DISCLAIMER, prompt)
