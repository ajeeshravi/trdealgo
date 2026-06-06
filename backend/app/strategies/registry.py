"""Strategy registry + safe loader for user-supplied custom strategies."""
from __future__ import annotations

from typing import Any

from app.strategies.base import StrategyBase
from app.strategies.builtin import (
    BreakoutStrategy,
    MeanReversionStrategy,
    MomentumStrategy,
    TrendFollowingStrategy,
)
from app.strategies.options_strategies import (
    CoveredCallStrategy,
    IronCondorStrategy,
    WheelStrategy,
)

_REGISTRY: dict[str, type[StrategyBase]] = {
    s.key: s
    for s in (
        MomentumStrategy,
        MeanReversionStrategy,
        BreakoutStrategy,
        TrendFollowingStrategy,
        CoveredCallStrategy,
        WheelStrategy,
        IronCondorStrategy,
    )
}


def register(cls: type[StrategyBase]) -> None:
    _REGISTRY[cls.key] = cls


def get_strategy(key: str) -> type[StrategyBase]:
    if key not in _REGISTRY:
        raise KeyError(f"unknown strategy: {key!r}")
    return _REGISTRY[key]


def catalog() -> list[dict[str, Any]]:
    """Plugin catalog with parameter schemas for the dashboard."""
    return [
        {
            "key": cls.key,
            "display_name": cls.display_name,
            "asset_classes": [a.value for a in cls.asset_classes],
            "param_schema": cls.param_schema,
        }
        for cls in _REGISTRY.values()
    ]


# --- Custom strategy validation (sandboxed compile check) ---
_FORBIDDEN = ("import os", "import sys", "subprocess", "open(", "__import__",
              "eval(", "exec(", "socket", "shutil", "pathlib")


def validate_custom_code(code: str) -> tuple[bool, str]:
    """Lightweight static check before a custom strategy is accepted.

    Production should execute custom code in a real sandbox (separate process,
    seccomp/gVisor, no network/filesystem). This catches obvious abuse and
    confirms the code defines a StrategyBase subclass with ``generate``.
    """
    lowered = code.lower()
    for token in _FORBIDDEN:
        if token in lowered:
            return False, f"forbidden token in custom strategy: {token!r}"
    try:
        compile(code, "<custom_strategy>", "exec")
    except SyntaxError as exc:
        return False, f"syntax error: {exc}"
    if "StrategyBase" not in code or "def generate" not in code:
        return False, "must subclass StrategyBase and implement generate()"
    return True, "ok"
