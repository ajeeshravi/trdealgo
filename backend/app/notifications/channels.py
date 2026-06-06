"""Notification channels: email, Telegram, Discord, Slack + event router."""
from __future__ import annotations

import abc
from email.message import EmailMessage

import httpx

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("notifications")

# Canonical events the platform emits.
EVENTS = (
    "trade_executed",
    "position_closed",
    "risk_alert",
    "strategy_alert",
    "system_error",
)


class NotificationChannel(abc.ABC):
    kind: str = "base"

    @abc.abstractmethod
    async def send(self, title: str, body: str) -> None:
        ...


class EmailChannel(NotificationChannel):
    kind = "email"

    def __init__(self, to_addr: str) -> None:
        self.to_addr = to_addr

    async def send(self, title: str, body: str) -> None:
        import aiosmtplib  # optional dependency; imported lazily

        msg = EmailMessage()
        msg["From"] = settings.SMTP_USER
        msg["To"] = self.to_addr
        msg["Subject"] = f"[{settings.APP_NAME}] {title}"
        msg.set_content(body)
        await aiosmtplib.send(
            msg, hostname=settings.SMTP_HOST, port=settings.SMTP_PORT,
            username=settings.SMTP_USER, password=settings.SMTP_PASSWORD, start_tls=True,
        )


class TelegramChannel(NotificationChannel):
    kind = "telegram"

    def __init__(self, bot_token: str, chat_id: str) -> None:
        self.bot_token = bot_token
        self.chat_id = chat_id

    async def send(self, title: str, body: str) -> None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            await c.post(
                f"https://api.telegram.org/bot{self.bot_token}/sendMessage",
                json={"chat_id": self.chat_id, "text": f"*{title}*\n{body}",
                      "parse_mode": "Markdown"},
            )


class DiscordChannel(NotificationChannel):
    kind = "discord"

    def __init__(self, webhook_url: str) -> None:
        self.webhook_url = webhook_url

    async def send(self, title: str, body: str) -> None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            await c.post(self.webhook_url, json={"content": f"**{title}**\n{body}"})


class SlackChannel(NotificationChannel):
    kind = "slack"

    def __init__(self, webhook_url: str) -> None:
        self.webhook_url = webhook_url

    async def send(self, title: str, body: str) -> None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            await c.post(self.webhook_url, json={"text": f"*{title}*\n{body}"})


class NotificationRouter:
    """Dispatches an event to all channels subscribed to it."""

    def __init__(self) -> None:
        self._subs: list[tuple[NotificationChannel, set[str]]] = []

    def subscribe(self, channel: NotificationChannel, events: set[str]) -> None:
        self._subs.append((channel, events))

    async def emit(self, event: str, title: str, body: str) -> None:
        for channel, events in self._subs:
            if event in events:
                try:
                    await channel.send(title, body)
                except Exception as exc:  # noqa: BLE001 - one channel must not break others
                    log.warning("notify.failed", kind=channel.kind, error=str(exc))
