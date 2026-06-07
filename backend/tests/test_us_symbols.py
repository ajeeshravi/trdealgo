"""Curated US symbol universe search."""
from __future__ import annotations

from app.services import us_symbols


def test_name_match():
    syms = [r["internal_symbol"] for r in us_symbols.search("apple")]
    assert "AAPL" in syms


def test_ticker_prefix_match():
    syms = [r["internal_symbol"] for r in us_symbols.search("XL", limit=50)]
    # Several SPDR sector ETFs start with XL.
    assert {"XLK", "XLF", "XLE"}.issubset(set(syms))


def test_segment_filter_etf():
    rows = us_symbols.search("S", limit=100, segment="ETF")
    assert rows and all(r["segment"] == "ETF" for r in rows)


def test_get_known_and_unknown():
    assert us_symbols.get("nvda")["name"].startswith("NVIDIA")
    assert us_symbols.get("ZZZZ") is None
