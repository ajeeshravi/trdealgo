"""Curated US symbol universe.

A lightweight, dependency-free symbol master of liquid US ETFs and large-cap
stocks. It backs symbol search / filters so the UI surfaces real names (e.g.
"apple" -> AAPL, "tech" -> XLK) without needing a seeded DB table or a vendor
call. Any ticker not in this list still resolves via the equity passthrough in
the symbols endpoint, so the universe is convenient, not restrictive.
"""
from __future__ import annotations

# (symbol, name, segment)  segment: "ETF" | "EQUITY"
_UNIVERSE: list[tuple[str, str, str]] = [
    # --- Broad-market / index ETFs ---
    ("SPY", "SPDR S&P 500 ETF", "ETF"),
    ("VOO", "Vanguard S&P 500 ETF", "ETF"),
    ("IVV", "iShares Core S&P 500 ETF", "ETF"),
    ("QQQ", "Invesco QQQ (Nasdaq 100)", "ETF"),
    ("DIA", "SPDR Dow Jones Industrial Average ETF", "ETF"),
    ("IWM", "iShares Russell 2000 ETF", "ETF"),
    ("VTI", "Vanguard Total Stock Market ETF", "ETF"),
    ("MDY", "SPDR S&P MidCap 400 ETF", "ETF"),
    ("IJR", "iShares Core S&P Small-Cap ETF", "ETF"),
    ("ONEQ", "Fidelity Nasdaq Composite ETF", "ETF"),
    ("VIXY", "ProShares VIX Short-Term Futures ETF", "ETF"),
    # --- SPDR sector ETFs ---
    ("XLK", "Technology Select Sector SPDR", "ETF"),
    ("XLF", "Financial Select Sector SPDR", "ETF"),
    ("XLV", "Health Care Select Sector SPDR", "ETF"),
    ("XLE", "Energy Select Sector SPDR", "ETF"),
    ("XLY", "Consumer Discretionary Select Sector SPDR", "ETF"),
    ("XLP", "Consumer Staples Select Sector SPDR", "ETF"),
    ("XLI", "Industrial Select Sector SPDR", "ETF"),
    ("XLB", "Materials Select Sector SPDR", "ETF"),
    ("XLU", "Utilities Select Sector SPDR", "ETF"),
    ("XLRE", "Real Estate Select Sector SPDR", "ETF"),
    ("XLC", "Communication Services Select Sector SPDR", "ETF"),
    # --- Thematic / commodity / bond ETFs ---
    ("SMH", "VanEck Semiconductor ETF", "ETF"),
    ("SOXX", "iShares Semiconductor ETF", "ETF"),
    ("ARKK", "ARK Innovation ETF", "ETF"),
    ("GLD", "SPDR Gold Shares", "ETF"),
    ("SLV", "iShares Silver Trust", "ETF"),
    ("TLT", "iShares 20+ Year Treasury Bond ETF", "ETF"),
    ("HYG", "iShares iBoxx High Yield Corporate Bond ETF", "ETF"),
    # --- Mega / large-cap stocks ---
    ("AAPL", "Apple Inc.", "EQUITY"),
    ("MSFT", "Microsoft Corporation", "EQUITY"),
    ("GOOGL", "Alphabet Inc. Class A", "EQUITY"),
    ("GOOG", "Alphabet Inc. Class C", "EQUITY"),
    ("AMZN", "Amazon.com Inc.", "EQUITY"),
    ("NVDA", "NVIDIA Corporation", "EQUITY"),
    ("META", "Meta Platforms Inc.", "EQUITY"),
    ("TSLA", "Tesla Inc.", "EQUITY"),
    ("BRK.B", "Berkshire Hathaway Inc. Class B", "EQUITY"),
    ("JPM", "JPMorgan Chase & Co.", "EQUITY"),
    ("V", "Visa Inc.", "EQUITY"),
    ("MA", "Mastercard Inc.", "EQUITY"),
    ("UNH", "UnitedHealth Group Inc.", "EQUITY"),
    ("HD", "The Home Depot Inc.", "EQUITY"),
    ("PG", "Procter & Gamble Co.", "EQUITY"),
    ("JNJ", "Johnson & Johnson", "EQUITY"),
    ("XOM", "Exxon Mobil Corporation", "EQUITY"),
    ("CVX", "Chevron Corporation", "EQUITY"),
    ("KO", "The Coca-Cola Company", "EQUITY"),
    ("PEP", "PepsiCo Inc.", "EQUITY"),
    ("COST", "Costco Wholesale Corporation", "EQUITY"),
    ("WMT", "Walmart Inc.", "EQUITY"),
    ("BAC", "Bank of America Corporation", "EQUITY"),
    ("DIS", "The Walt Disney Company", "EQUITY"),
    ("NFLX", "Netflix Inc.", "EQUITY"),
    ("AMD", "Advanced Micro Devices Inc.", "EQUITY"),
    ("INTC", "Intel Corporation", "EQUITY"),
    ("CSCO", "Cisco Systems Inc.", "EQUITY"),
    ("ORCL", "Oracle Corporation", "EQUITY"),
    ("CRM", "Salesforce Inc.", "EQUITY"),
    ("ADBE", "Adobe Inc.", "EQUITY"),
    ("QCOM", "Qualcomm Inc.", "EQUITY"),
    ("TXN", "Texas Instruments Inc.", "EQUITY"),
    ("AVGO", "Broadcom Inc.", "EQUITY"),
    ("PFE", "Pfizer Inc.", "EQUITY"),
    ("MRK", "Merck & Co. Inc.", "EQUITY"),
    ("ABBV", "AbbVie Inc.", "EQUITY"),
    ("LLY", "Eli Lilly and Company", "EQUITY"),
    ("T", "AT&T Inc.", "EQUITY"),
    ("VZ", "Verizon Communications Inc.", "EQUITY"),
    ("NKE", "Nike Inc.", "EQUITY"),
    ("MCD", "McDonald's Corporation", "EQUITY"),
    ("SBUX", "Starbucks Corporation", "EQUITY"),
    ("BA", "The Boeing Company", "EQUITY"),
    ("CAT", "Caterpillar Inc.", "EQUITY"),
    ("GE", "General Electric Company", "EQUITY"),
    ("F", "Ford Motor Company", "EQUITY"),
    ("GM", "General Motors Company", "EQUITY"),
    ("WFC", "Wells Fargo & Company", "EQUITY"),
    ("GS", "The Goldman Sachs Group Inc.", "EQUITY"),
    ("MS", "Morgan Stanley", "EQUITY"),
    ("C", "Citigroup Inc.", "EQUITY"),
    ("PYPL", "PayPal Holdings Inc.", "EQUITY"),
    ("UBER", "Uber Technologies Inc.", "EQUITY"),
]

# Build once at import.
UNIVERSE = [
    {
        "internal_symbol": sym,
        "trading_symbol": sym,
        "name": name,
        "underlying": sym,
        "exchange": "US",
        "segment": segment,
    }
    for sym, name, segment in _UNIVERSE
]
_BY_SYMBOL = {row["internal_symbol"]: row for row in UNIVERSE}


def search(query: str, limit: int = 25, segment: str | None = None) -> list[dict]:
    """Match by ticker prefix or name substring (case-insensitive)."""
    q = (query or "").strip().upper()
    if not q:
        return []
    seg = segment.upper() if segment else None
    out: list[dict] = []
    for row in UNIVERSE:
        if seg and row["segment"] != seg:
            continue
        if row["internal_symbol"].startswith(q) or q.lower() in row["name"].lower():
            out.append(row)
        if len(out) >= limit:
            break
    return out


def get(symbol: str) -> dict | None:
    return _BY_SYMBOL.get((symbol or "").strip().upper())


def underlyings(query: str, limit: int = 30) -> list[str]:
    return [r["internal_symbol"] for r in search(query, limit)]
