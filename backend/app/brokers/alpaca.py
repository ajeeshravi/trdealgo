"""Alpaca broker adapter (REST trading API + websocket trade updates).

Implemented directly against Alpaca's HTTP API with httpx so it is runnable
without pinning the SDK internals. Supports paper and live via base URL.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import httpx

from app.brokers.base import BrokerBase, BrokerConnectionError
from app.brokers.models import (
    Account,
    AssetClass,
    Margin,
    Order,
    OrderRequest,
    OrderSide,
    OrderStatus,
    OrderType,
    Position,
)
from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("broker.alpaca")

_STATUS_MAP = {
    "new": OrderStatus.ACCEPTED,
    "accepted": OrderStatus.ACCEPTED,
    "pending_new": OrderStatus.PENDING,
    "partially_filled": OrderStatus.PARTIALLY_FILLED,
    "filled": OrderStatus.FILLED,
    "canceled": OrderStatus.CANCELED,
    "rejected": OrderStatus.REJECTED,
    "expired": OrderStatus.EXPIRED,
}


class AlpacaBroker(BrokerBase):
    name = "alpaca"
    supports_options = True
    supports_futures = False

    def __init__(self, credentials: dict[str, Any], **kw: Any) -> None:
        super().__init__(credentials, **kw)
        # Route to the paper or live trading API. Alpaca paper API keys are
        # prefixed "PK" and live keys "AK", so honour the key prefix as well as
        # the explicit `paper` flag — the broker page links accounts with
        # is_paper=false (paper/live is chosen per strategy run), so without the
        # prefix check a paper key would be validated against the live endpoint
        # and fail.
        api_key = str(credentials.get("api_key", ""))
        is_paper = self.paper or api_key.upper().startswith("PK")
        self._base = (
            settings.ALPACA_BASE_URL if is_paper else "https://api.alpaca.markets"
        )
        self._client: httpx.AsyncClient | None = None

    def _headers(self) -> dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.credentials["api_key"],
            "APCA-API-SECRET-KEY": self.credentials["api_secret"],
        }

    # --- lifecycle ---
    async def connect(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=self._base, headers=self._headers(), timeout=10.0
        )
        # Validate credentials by fetching the account.
        try:
            await self.get_account()
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 401:
                env = "paper" if "paper-api" in self._base else "live"
                raise BrokerConnectionError(
                    f"Alpaca rejected these keys on the {env} endpoint (401). "
                    "Alpaca paper and live use SEPARATE keys — paper keys start with "
                    "'PK' (from the Alpaca paper dashboard), live keys with 'AK'. "
                    f"Use {env} keys for this account."
                ) from exc
            raise BrokerConnectionError(f"alpaca auth failed: {exc}") from exc
        await self._emit_status("connected")
        log.info("alpaca.connected", paper=self.paper)

    async def disconnect(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
        await self._emit_status("disconnected")

    async def is_connected(self) -> bool:
        return self._client is not None

    def _c(self) -> httpx.AsyncClient:
        if self._client is None:
            raise BrokerConnectionError("alpaca not connected")
        return self._client

    # --- account / portfolio ---
    async def get_account(self) -> Account:
        r = await self._c().get("/v2/account")
        r.raise_for_status()
        d = r.json()
        return Account(
            account_id=d["account_number"],
            cash=Decimal(d["cash"]),
            equity=Decimal(d["equity"]),
            buying_power=Decimal(d["buying_power"]),
            margin=Margin(
                maintenance=Decimal(d.get("maintenance_margin", "0")),
                buying_power=Decimal(d["buying_power"]),
            ),
            pattern_day_trader=d.get("pattern_day_trader", False),
            raw=d,
        )

    async def get_positions(self) -> list[Position]:
        r = await self._c().get("/v2/positions")
        r.raise_for_status()
        out: list[Position] = []
        for p in r.json():
            out.append(
                Position(
                    symbol=p["symbol"],
                    asset_class=AssetClass.STOCK
                    if p.get("asset_class") == "us_equity"
                    else AssetClass.OPTION,
                    qty=Decimal(p["qty"]),
                    avg_price=Decimal(p["avg_entry_price"]),
                    market_price=Decimal(p["current_price"]),
                    unrealized_pnl=Decimal(p["unrealized_pl"]),
                )
            )
        return out

    # --- orders ---
    def _to_payload(self, req: OrderRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "symbol": req.symbol,
            "qty": str(req.qty),
            "side": req.side.value,
            "time_in_force": req.tif.value,
            "extended_hours": req.extended_hours,
        }
        if req.client_order_id:
            payload["client_order_id"] = req.client_order_id

        ot = req.order_type
        if ot in (OrderType.MARKET, OrderType.BRACKET, OrderType.OCO):
            payload["type"] = "market" if ot is OrderType.MARKET else "limit"
        elif ot is OrderType.LIMIT:
            payload["type"] = "limit"
            payload["limit_price"] = str(req.limit_price)
        elif ot is OrderType.STOP:
            payload["type"] = "stop"
            payload["stop_price"] = str(req.stop_price)
        elif ot is OrderType.STOP_LIMIT:
            payload["type"] = "stop_limit"
            payload["limit_price"] = str(req.limit_price)
            payload["stop_price"] = str(req.stop_price)
        elif ot is OrderType.TRAILING_STOP:
            payload["type"] = "trailing_stop"
            payload["trail_percent"] = str(req.trail_percent)

        if ot is OrderType.BRACKET:
            payload["order_class"] = "bracket"
            payload["take_profit"] = {"limit_price": str(req.take_profit_price)}
            payload["stop_loss"] = {"stop_price": str(req.stop_loss_price)}
        elif ot is OrderType.OCO:
            payload["order_class"] = "oco"
            payload["take_profit"] = {"limit_price": str(req.take_profit_price)}
            payload["stop_loss"] = {"stop_price": str(req.stop_loss_price)}
        return payload

    def _to_order(self, d: dict[str, Any]) -> Order:
        return Order(
            id=d["id"],
            client_order_id=d.get("client_order_id"),
            symbol=d["symbol"],
            side=OrderSide(d["side"]),
            order_type=OrderType(d["type"]) if d["type"] in OrderType._value2member_map_ else OrderType.MARKET,
            qty=Decimal(d["qty"]),
            filled_qty=Decimal(d.get("filled_qty", "0")),
            status=_STATUS_MAP.get(d["status"], OrderStatus.PENDING),
            limit_price=Decimal(d["limit_price"]) if d.get("limit_price") else None,
            stop_price=Decimal(d["stop_price"]) if d.get("stop_price") else None,
            avg_fill_price=Decimal(d["filled_avg_price"])
            if d.get("filled_avg_price")
            else None,
            raw=d,
        )

    async def place_order(self, req: OrderRequest) -> Order:
        r = await self._c().post("/v2/orders", json=self._to_payload(req))
        r.raise_for_status()
        return self._to_order(r.json())

    async def cancel_order(self, broker_order_id: str) -> None:
        r = await self._c().delete(f"/v2/orders/{broker_order_id}")
        r.raise_for_status()

    async def modify_order(self, broker_order_id: str, req: OrderRequest) -> Order:
        patch: dict[str, Any] = {"qty": str(req.qty)}
        if req.limit_price is not None:
            patch["limit_price"] = str(req.limit_price)
        if req.stop_price is not None:
            patch["stop_price"] = str(req.stop_price)
        r = await self._c().patch(f"/v2/orders/{broker_order_id}", json=patch)
        r.raise_for_status()
        return self._to_order(r.json())

    async def get_orders(self, *, open_only: bool = True) -> list[Order]:
        r = await self._c().get(
            "/v2/orders", params={"status": "open" if open_only else "all"}
        )
        r.raise_for_status()
        return [self._to_order(o) for o in r.json()]

    # --- realtime trade updates over websocket ---
    async def stream_account_updates(self) -> AsyncIterator[dict[str, Any]]:
        import websockets

        url = (
            "wss://paper-api.alpaca.markets/stream"
            if self.paper
            else "wss://api.alpaca.markets/stream"
        )
        async for ws in websockets.connect(url):
            try:
                await ws.send(
                    json.dumps(
                        {
                            "action": "auth",
                            "key": self.credentials["api_key"],
                            "secret": self.credentials["api_secret"],
                        }
                    )
                )
                await ws.send(
                    json.dumps({"action": "listen", "data": {"streams": ["trade_updates"]}})
                )
                await self._emit_status("connected")
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("stream") == "trade_updates":
                        yield {"type": "order", "data": msg["data"]}
            except Exception as exc:  # noqa: BLE001 - reconnect via outer loop
                await self._emit_status("disconnected")
                log.warning("alpaca.stream.reconnect", error=str(exc))
                continue
