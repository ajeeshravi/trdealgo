"""Risk engine: the single mandatory gate before any order is routed.

``validate()`` runs the pre-trade rule chain and returns the first hard reject,
or ALLOW. The trading engine refuses to route on anything but ALLOW — there is
no bypass path, including for AI-generated orders.
"""
from __future__ import annotations

from app.brokers.models import OrderRequest
from app.core.logging import get_logger
from app.risk.rules import (
    DEFAULT_RULES,
    RiskContext,
    RiskDecision,
    RiskRule,
    Verdict,
)

log = get_logger("risk.engine")


class RiskEngine:
    def __init__(self, rules: list[RiskRule] | None = None) -> None:
        self.rules = rules or DEFAULT_RULES

    def validate(self, order: OrderRequest, ctx: RiskContext) -> RiskDecision:
        warnings: list[RiskDecision] = []
        for rule in self.rules:
            decision = rule.evaluate(order, ctx)
            if decision.verdict is Verdict.REJECT:
                log.warning(
                    "risk.reject",
                    rule=decision.rule,
                    reason=decision.reason,
                    symbol=order.symbol,
                )
                return decision
            if decision.verdict is Verdict.WARN:
                warnings.append(decision)
        if warnings:
            log.info("risk.warn", warnings=[w.rule for w in warnings], symbol=order.symbol)
        return RiskDecision(Verdict.ALLOW, "risk_engine", "passed all checks")


# Process-wide default engine.
risk_engine = RiskEngine()
