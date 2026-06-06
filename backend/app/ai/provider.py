"""AI provider abstraction (Anthropic Claude + OpenAI) for advisory analysis.

IMPORTANT: AI is strictly advisory. Nothing here places orders or relaxes risk
controls. Any trade derived from an AI suggestion still flows through the Risk
Engine like every other order.
"""
from __future__ import annotations

import abc
import json

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("ai")


class AIProvider(abc.ABC):
    @abc.abstractmethod
    async def complete(self, system: str, prompt: str, *, json_mode: bool = False) -> str:
        ...


class AnthropicProvider(AIProvider):
    def __init__(self) -> None:
        from anthropic import AsyncAnthropic

        self._client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
        self._model = settings.ANTHROPIC_MODEL

    async def complete(self, system, prompt, *, json_mode=False) -> str:
        msg = await self._client.messages.create(
            model=self._model,
            max_tokens=2000,
            system=system + (" Respond with valid JSON only." if json_mode else ""),
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text


class OpenAIProvider(AIProvider):
    def __init__(self) -> None:
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        self._model = settings.OPENAI_MODEL

    async def complete(self, system, prompt, *, json_mode=False) -> str:
        resp = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"} if json_mode else {"type": "text"},
        )
        return resp.choices[0].message.content or ""


def get_provider(name: str | None = None) -> AIProvider:
    name = name or settings.AI_DEFAULT_PROVIDER
    return AnthropicProvider() if name == "anthropic" else OpenAIProvider()


async def _json_complete(provider: AIProvider, system: str, prompt: str) -> dict:
    raw = await provider.complete(system, prompt, json_mode=True)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}
