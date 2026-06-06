"""Risk engine unit tests — proving no unsafe order passes."""
from decimal import Decimal

from app.brokers.models import (
    Account,
    AssetClass,
    Margin,
    OrderRequest,
    OrderSide,
    OrderType,
)
from app.risk.engine import RiskEngine
from app.risk.rules import RiskContext, RiskProfile, Verdict


def _account(equity="100000", bp="100000") -> Account:
    return Account(
        account_id="A1",
        cash=Decimal(bp),
        equity=Decimal(equity),
        buying_power=Decimal(bp),
        margin=Margin(buying_power=Decimal(bp)),
    )


def _ctx(**overrides) -> RiskContext:
    base = dict(
        account=_account(),
        positions=[],
        risk_profile=RiskProfile(
            daily_loss_limit=Decimal("2000"),
            max_drawdown_pct=Decimal("0.10"),
            max_exposure=Decimal("50000"),
            max_position_pct=Decimal("0.20"),
        ),
        reference_price=Decimal("100"),
    )
    base.update(overrides)
    return RiskContext(**base)


def _order(qty="100", side=OrderSide.BUY) -> OrderRequest:
    return OrderRequest(
        symbol="AAPL", asset_class=AssetClass.STOCK, side=side,
        qty=Decimal(qty), order_type=OrderType.MARKET,
    )


def test_normal_order_allowed():
    decision = RiskEngine().validate(_order("100"), _ctx())
    assert decision.verdict is Verdict.ALLOW


def test_kill_switch_blocks():
    decision = RiskEngine().validate(_order("1"), _ctx(kill_switch_active=True))
    assert decision.verdict is Verdict.REJECT
    assert decision.rule == "kill_switch"


def test_broker_disconnect_blocks():
    decision = RiskEngine().validate(_order("1"), _ctx(broker_connected=False))
    assert decision.verdict is Verdict.REJECT
    assert decision.rule == "broker_connected"


def test_halted_symbol_blocks():
    decision = RiskEngine().validate(_order("1"), _ctx(halted_symbols={"AAPL"}))
    assert decision.verdict is Verdict.REJECT


def test_daily_loss_limit_blocks():
    decision = RiskEngine().validate(
        _order("1"), _ctx(realized_pnl_today=Decimal("-2500"))
    )
    assert decision.verdict is Verdict.REJECT
    assert decision.rule == "daily_loss_limit"


def test_max_position_pct_blocks():
    # 1000 shares * $100 = $100k = 100% of equity > 20% cap.
    decision = RiskEngine().validate(_order("1000"), _ctx())
    assert decision.verdict is Verdict.REJECT
    assert decision.rule == "max_position_size"


def test_buying_power_blocks():
    decision = RiskEngine().validate(
        _order("100"), _ctx(account=_account(equity="100000", bp="500"))
    )
    assert decision.verdict is Verdict.REJECT
    assert decision.rule == "buying_power"


def test_drawdown_blocks():
    decision = RiskEngine().validate(
        _order("1"),
        _ctx(account=_account(equity="85000"), peak_equity=Decimal("100000")),
    )
    assert decision.verdict is Verdict.REJECT
    assert decision.rule == "max_drawdown"
