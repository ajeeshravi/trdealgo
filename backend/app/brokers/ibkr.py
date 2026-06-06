"""Interactive Brokers adapter (via ib_insync / TWS or IB Gateway).

Requires a running TWS or IB Gateway. ib_insync is imported lazily so the
package imports cleanly even when the dependency or gateway is absent.
Supports stocks, ETFs, options and futures.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

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

log = get_logger("broker.ibkr")


class IBKRBroker(BrokerBase):
    name = "ibkr"
    supports_options = True
    supports_futures = True

    def __init__(self, credentials: dict[str, Any], **kw: Any) -> None:
        super().__init__(credentials, **kw)
        self._ib: Any = None
        self._host = credentials.get("host", settings.IBKR_HOST)
        self._port = int(credentials.get("port", settings.IBKR_PORT))
        self._client_id = int(credentials.get("client_id", 1))

    async def connect(self) -> None:
        try:
            from ib_insync import IB
        except ImportError as exc:  # pragma: no cover
            raise BrokerConnectionError("ib_insync not installed") from exc

        self._ib = IB()
        try:
            await self._ib.connectAsync(
                self._host, self._port, clientId=self._client_id
            )
        except Exception as exc:  # noqa: BLE001
            raise BrokerConnectionError(f"ibkr connect failed: {exc}") from exc
        await self._emit_status("connected")
        log.info("ibkr.connected", host=self._host, port=self._port)

    async def disconnect(self) -> None:
        if self._ib and self._ib.isConnected():
            self._ib.disconnect()
        await self._emit_status("disconnected")

    async def is_connected(self) -> bool:
        return bool(self._ib and self._ib.isConnected())

    def _ib_or_raise(self) -> Any:
        if not self._ib or not self._ib.isConnected():
            raise BrokerConnectionError("ibkr not connected")
        return self._ib

    async def get_account(self) -> Account:
        ib = self._ib_or_raise()
        values = {v.tag: v.value for v in await ib.accountValuesAsync()}
        return Account(
            account_id=values.get("AccountCode", ""),
            cash=Decimal(values.get("TotalCashValue", "0")),
            equity=Decimal(values.get("NetLiquidation", "0")),
            buying_power=Decimal(values.get("BuyingPower", "0")),
            margin=Margin(
                maintenance=Decimal(values.get("MaintMarginReq", "0")),
                excess_liquidity=Decimal(values.get("ExcessLiquidity", "0")),
                buying_power=Decimal(values.get("BuyingPower", "0")),
            ),
            raw=values,
        )

    async def get_positions(self) -> list[Position]:
        ib = self._ib_or_raise()
        out: list[Position] = []
        for p in ib.positions():
            sec = p.contract.secType
            ac = {
                "STK": AssetClass.STOCK,
                "OPT": AssetClass.OPTION,
                "FUT": AssetClass.FUTURE,
            }.get(sec, AssetClass.STOCK)
            out.append(
                Position(
                    symbol=p.contract.localSymbol or p.contract.symbol,
                    asset_class=ac,
                    qty=Decimal(str(p.position)),
                    avg_price=Decimal(str(p.avgCost)),
                )
            )
        return out

    def _build_contract(self, req: OrderRequest) -> Any:
        from ib_insync import Future, Option, Stock

        if req.asset_class is AssetClass.FUTURE:
            return Future(req.symbol, exchange="CME")
        if req.asset_class is AssetClass.OPTION and req.legs:
            leg = req.legs[0]
            return Option(
                req.symbol,
                leg.expiry,
                float(leg.strike),
                "C" if leg.right == "call" else "P",
                exchange="SMART",
            )
        return Stock(req.symbol, "SMART", "USD")

    def _build_order(self, req: OrderRequest) -> Any:
        from ib_insync import (
            LimitOrder,
            MarketOrder,
            StopLimitOrder,
            StopOrder,
        )
        from ib_insync import (
            Order as IbOrder,
        )

        action = "BUY" if req.side is OrderSide.BUY else "SELL"
        qty = float(req.qty)
        ot = req.order_type
        if ot is OrderType.MARKET:
            return MarketOrder(action, qty)
        if ot is OrderType.LIMIT:
            return LimitOrder(action, qty, float(req.limit_price))
        if ot is OrderType.STOP:
            return StopOrder(action, qty, float(req.stop_price))
        if ot is OrderType.STOP_LIMIT:
            return StopLimitOrder(
                action, qty, float(req.limit_price), float(req.stop_price)
            )
        if ot is OrderType.TRAILING_STOP:
            o = IbOrder(action=action, totalQuantity=qty, orderType="TRAIL")
            o.trailingPercent = float(req.trail_percent)
            return o
        return MarketOrder(action, qty)

    async def place_order(self, req: OrderRequest) -> Order:
        ib = self._ib_or_raise()
        contract = self._build_contract(req)
        await ib.qualifyContractsAsync(contract)
        trade = ib.placeOrder(contract, self._build_order(req))
        return Order(
            id=str(trade.order.orderId),
            client_order_id=req.client_order_id,
            symbol=req.symbol,
            side=req.side,
            order_type=req.order_type,
            qty=req.qty,
            filled_qty=Decimal(str(trade.orderStatus.filled or 0)),
            status=OrderStatus.ACCEPTED,
        )

    async def cancel_order(self, broker_order_id: str) -> None:
        ib = self._ib_or_raise()
        for t in ib.openTrades():
            if str(t.order.orderId) == broker_order_id:
                ib.cancelOrder(t.order)
                return

    async def modify_order(self, broker_order_id: str, req: OrderRequest) -> Order:
        # IBKR modify = re-place with same orderId; simplified here.
        return await self.place_order(req)

    async def get_orders(self, *, open_only: bool = True) -> list[Order]:
        ib = self._ib_or_raise()
        trades = ib.openTrades() if open_only else ib.trades()
        return [
            Order(
                id=str(t.order.orderId),
                client_order_id=None,
                symbol=t.contract.symbol,
                side=OrderSide.BUY if t.order.action == "BUY" else OrderSide.SELL,
                order_type=OrderType.MARKET,
                qty=Decimal(str(t.order.totalQuantity)),
                filled_qty=Decimal(str(t.orderStatus.filled or 0)),
                status=OrderStatus.ACCEPTED,
            )
            for t in trades
        ]

    async def stream_account_updates(self) -> AsyncIterator[dict[str, Any]]:
        import asyncio

        ib = self._ib_or_raise()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        def _on_status(trade: Any) -> None:
            queue.put_nowait(
                {
                    "type": "order",
                    "data": {
                        "id": str(trade.order.orderId),
                        "status": trade.orderStatus.status,
                        "filled": trade.orderStatus.filled,
                    },
                }
            )

        ib.orderStatusEvent += _on_status
        try:
            while True:
                yield await queue.get()
        finally:
            ib.orderStatusEvent -= _on_status
