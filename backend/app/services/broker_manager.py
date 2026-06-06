"""Connected-broker registry.

Holds live broker sessions per account id, instantiated from encrypted
credentials stored in the DB. Used by the API and trading engine.
"""
from __future__ import annotations

import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.brokers.base import BrokerBase
from app.brokers.factory import create_broker
from app.core.logging import get_logger
from app.core.security import decrypt_secret
from app.models.trading import BrokerAccount
from app.risk import kill_switch

log = get_logger("broker_manager")


class BrokerManager:
    def __init__(self) -> None:
        self._sessions: dict[str, BrokerBase] = {}

    async def get(self, db: AsyncSession, account_id: str) -> BrokerBase:
        if account_id in self._sessions:
            broker = self._sessions[account_id]
            if await broker.is_connected():
                return broker

        account = await db.get(BrokerAccount, account_id)
        if account is None:
            raise KeyError(f"broker account {account_id} not found")

        creds = json.loads(decrypt_secret(account.credentials_enc))

        async def on_status(status: str) -> None:
            # Broker-disconnect protection: freeze new orders for this account.
            if status == "disconnected":
                await kill_switch.activate(account_id, "broker disconnected", by="system")
            elif status == "connected":
                await kill_switch.deactivate(account_id)

        broker = create_broker(
            account.broker, creds, paper=account.paper, on_status=on_status
        )
        await broker.connect()
        self._sessions[account_id] = broker
        log.info("broker.session_open", account_id=account_id, broker=account.broker)
        return broker

    async def disconnect(self, account_id: str) -> None:
        broker = self._sessions.pop(account_id, None)
        if broker:
            await broker.disconnect()


broker_manager = BrokerManager()
