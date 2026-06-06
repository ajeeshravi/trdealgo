"""WebSocket connection manager + Redis pub/sub bridge.

Clients subscribe to channels (quotes:SYMBOL, orders, positions, risk). The
manager bridges Redis pub/sub messages to the right connections.
"""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict

from fastapi import WebSocket

from app.core.logging import get_logger
from app.core.redis import get_redis

log = get_logger("ws")


class ConnectionManager:
    def __init__(self) -> None:
        # channel -> set of websockets
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()

    async def subscribe(self, ws: WebSocket, channels: list[str]) -> None:
        async with self._lock:
            for ch in channels:
                self._subs[ch].add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            for subs in self._subs.values():
                subs.discard(ws)

    async def broadcast(self, channel: str, message: dict) -> None:
        dead: list[WebSocket] = []
        for ws in list(self._subs.get(channel, ())):
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            await self.disconnect(ws)

    async def run_redis_bridge(self, channels: list[str]) -> None:
        """Forward Redis pub/sub messages to subscribed WS clients."""
        r = get_redis()
        pubsub = r.pubsub()
        await pubsub.psubscribe(*channels)
        async for msg in pubsub.listen():
            if msg["type"] != "pmessage":
                continue
            channel = msg["channel"]
            try:
                payload = json.loads(msg["data"])
            except (json.JSONDecodeError, TypeError):
                payload = {"data": msg["data"]}
            await self.broadcast(channel, {"channel": channel, "data": payload})


manager = ConnectionManager()
