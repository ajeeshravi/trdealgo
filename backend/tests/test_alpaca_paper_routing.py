"""AlpacaBroker routes to the paper/live trading API by key prefix + flag."""
from __future__ import annotations

from app.brokers.alpaca import AlpacaBroker
from app.core.config import settings

LIVE = "https://api.alpaca.markets"


def test_paper_key_prefix_routes_to_paper_even_when_flag_false():
    b = AlpacaBroker({"api_key": "PKTEST123", "api_secret": "x"}, paper=False)
    assert b._base == settings.ALPACA_BASE_URL


def test_live_key_routes_to_live():
    b = AlpacaBroker({"api_key": "AKTEST123", "api_secret": "x"}, paper=False)
    assert b._base == LIVE


def test_explicit_paper_flag_wins():
    b = AlpacaBroker({"api_key": "AKTEST123", "api_secret": "x"}, paper=True)
    assert b._base == settings.ALPACA_BASE_URL
