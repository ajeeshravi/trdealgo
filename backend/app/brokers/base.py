"""Abstract broker interface and an auto-reconnect mixin.

To add a new broker, implement ``BrokerBase`` and register it in
``factory.py``. Nothing in the trading engine, strategies, or risk layer
imports a concrete broker.
"""
from __future__ import annotations

import abc
import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from app.brokers.models import (
    Account,
    Order,
    OrderRequest,
    Position,
)
from app.core.logging import get_logger

log = get_logger("broker")


class BrokerError(Exception):
    """Base broker error."""


class BrokerConnectionError(BrokerError):
    """Raised when the broker session cannot be established/maintained."""


class AutoReconnectMixin:
    """Exponential-backoff reconnect loop with heartbeat.

    Adapters set ``self._reconnect_cb`` (called after a successful reconnect)
    and emit status changes through ``self._on_status``.
    """

    _max_backoff: float = 30.0
    _on_status: Callable[[str], Awaitable[None]] | None = None

    async def _emit_status(self, status: str) -> None:
        if self._on_status is not None:
            await self._on_status(status)

    async def _connect_with_retry(
        self, connect: Callable[[], Awaitable[None]]
    ) -> None:
        backoff = 1.0
        while True:
            try:
                await connect()
                await self._emit_status("connected")
                return
            except Exception as exc:  # noqa: BLE001 - we want to retry on any failure
                await self._emit_status("disconnected")
                log.warning("broker.reconnect", error=str(exc), backoff=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._max_backoff)


class BrokerBase(AutoReconnectMixin, abc.ABC):
    """Uniform contract every broker adapter must satisfy."""

    name: str = "base"
    supports_options: bool = False
    supports_futures: bool = False

    def __init__(
        self,
        credentials: dict[str, Any],
        *,
        paper: bool = True,
        on_status: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self.credentials = credentials
        self.paper = paper
        self._on_status = on_status

    # --- lifecycle ---
    @abc.abstractmethod
    async def connect(self) -> None:
        """Authenticate and establish the session (idempotent)."""

    @abc.abstractmethod
    async def disconnect(self) -> None:
        ...

    @abc.abstractmethod
    async def is_connected(self) -> bool:
        ...

    # --- account / portfolio ---
    @abc.abstractmethod
    async def get_account(self) -> Account:
        ...

    @abc.abstractmethod
    async def get_positions(self) -> list[Position]:
        ...

    async def get_holdings(self) -> list[Position]:
        """Long-term holdings; defaults to positions for cash-equity brokers."""
        return await self.get_positions()

    # --- orders ---
    @abc.abstractmethod
    async def place_order(self, req: OrderRequest) -> Order:
        ...

    @abc.abstractmethod
    async def cancel_order(self, broker_order_id: str) -> None:
        ...

    @abc.abstractmethod
    async def modify_order(self, broker_order_id: str, req: OrderRequest) -> Order:
        ...

    @abc.abstractmethod
    async def get_orders(self, *, open_only: bool = True) -> list[Order]:
        ...

    # --- realtime ---
    @abc.abstractmethod
    def stream_account_updates(self) -> AsyncIterator[dict[str, Any]]:
        """Async iterator of normalized order/position/account update events."""
        ...
