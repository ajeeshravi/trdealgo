"""Broker registry + factory.

Adding a broker = implement ``BrokerBase`` and register it here. No other code
changes required.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from app.brokers.alpaca import AlpacaBroker
from app.brokers.base import BrokerBase
from app.brokers.ibkr import IBKRBroker

# Concrete brokers available today. Future: tradier, tastytrade, tradestation, schwab.
_REGISTRY: dict[str, type[BrokerBase]] = {
    "alpaca": AlpacaBroker,
    "alpaca_paper": AlpacaBroker,  # same adapter, linked with paper=True
    "ibkr": IBKRBroker,
}

# Capability catalog surfaced via GET /brokers.
CAPABILITIES: dict[str, dict[str, Any]] = {
    "alpaca_paper": {"options": True, "futures": False, "paper": True, "status": "supported"},
    "alpaca": {"options": True, "futures": False, "paper": True, "status": "supported"},
    "ibkr": {"options": True, "futures": True, "paper": True, "status": "supported"},
    "tradier": {"status": "planned"},
    "tastytrade": {"status": "planned"},
    "tradestation": {"status": "planned"},
    "schwab": {"status": "planned"},
}


def register_broker(name: str, cls: type[BrokerBase]) -> None:
    _REGISTRY[name] = cls


def supported_brokers() -> list[str]:
    return list(_REGISTRY)


def create_broker(
    name: str,
    credentials: dict[str, Any],
    *,
    paper: bool = True,
    on_status: Callable[[str], Awaitable[None]] | None = None,
) -> BrokerBase:
    try:
        cls = _REGISTRY[name]
    except KeyError as exc:
        raise ValueError(f"unsupported broker: {name!r}") from exc
    return cls(credentials, paper=paper, on_status=on_status)
