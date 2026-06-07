"""Brokerage, trading, strategy and risk ORM models."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BrokerAccount(Base):
    __tablename__ = "broker_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    broker: Mapped[str] = mapped_column(String)            # alpaca|ibkr|...
    alias: Mapped[str | None] = mapped_column(String, nullable=True)
    # Human-facing account identifier shown on the card (e.g. the broker
    # account number / key id). `label` is an optional nickname.
    client_id: Mapped[str | None] = mapped_column(String, nullable=True)
    label: Mapped[str | None] = mapped_column(String, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    paper: Mapped[bool] = mapped_column(Boolean, default=True)
    credentials_enc: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String, default="disconnected")
    # Session lifecycle surfaced on the broker card.
    session_valid_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("broker_accounts.id", ondelete="CASCADE"), index=True)
    symbol: Mapped[str] = mapped_column(String)
    asset_class: Mapped[str] = mapped_column(String)
    qty: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    avg_price: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    market_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    unrealized_pnl: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_order_id: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("broker_accounts.id"), index=True)
    strategy_instance_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    symbol: Mapped[str] = mapped_column(String, index=True)
    asset_class: Mapped[str] = mapped_column(String)
    side: Mapped[str] = mapped_column(String)
    order_type: Mapped[str] = mapped_column(String)
    tif: Mapped[str] = mapped_column(String, default="day")
    qty: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    limit_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stop_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    status: Mapped[str] = mapped_column(String, default="new", index=True)
    broker_order_id: Mapped[str | None] = mapped_column(String, nullable=True)
    filled_qty: Mapped[Decimal] = mapped_column(Numeric(20, 6), default=0)
    avg_fill_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class Strategy(Base):
    __tablename__ = "strategies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    # Legacy free-form config (kept for backward compatibility).
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Lifecycle / dashboard surface.
    status: Mapped[str] = mapped_column(String, default="DRAFT")
    symbols: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    timeframe_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    capital: Mapped[Decimal] = mapped_column(Numeric(20, 2), default=0)
    # The no-code / plan builder payload and (optional) custom code.
    definition: Mapped[dict] = mapped_column(JSONB, default=dict)
    code: Mapped[str | None] = mapped_column(Text, nullable=True)
    risk: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Auto-start-on-login configuration.
    auto_start_on_login: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_start_broker_account_id: Mapped[str | None] = mapped_column(String, nullable=True)
    auto_start_is_paper: Mapped[bool] = mapped_column(Boolean, default=True)
    preferred_broker_account_ids: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)


class StrategyRun(Base):
    __tablename__ = "strategy_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("strategies.id", ondelete="CASCADE"), index=True
    )
    broker_account_id: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, default="LIVE")  # LIVE|PAPER|PAUSED|STOPPED
    is_paper: Mapped[bool] = mapped_column(Boolean, default=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pnl: Mapped[Decimal] = mapped_column(Numeric(20, 2), default=0)
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(20, 2), default=0)
    # Engine bookkeeping: paper positions per symbol + last-seen bar timestamps.
    # Shape: {"positions": {sym: {"qty": float, "avg_price": float}}, "last_ts": {sym: iso}}
    state: Mapped[dict] = mapped_column(JSONB, default=dict)


class StrategyLog(Base):
    __tablename__ = "strategy_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("strategies.id", ondelete="CASCADE"), index=True
    )
    run_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String, default="run")  # run|signal|order
    level: Mapped[str] = mapped_column(String, default="info")  # info|warn|error
    message: Mapped[str] = mapped_column(Text, default="")
    internal_symbol: Mapped[str | None] = mapped_column(String, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict)


class Trigger(Base):
    __tablename__ = "triggers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    broker_account_id: Mapped[str | None] = mapped_column(String, nullable=True)
    strategy_run_id: Mapped[str | None] = mapped_column(String, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String, nullable=True)
    role: Mapped[str] = mapped_column(String, default="ENTRY")  # ENTRY|SL|TARGET
    internal_symbol: Mapped[str] = mapped_column(String, index=True)
    side: Mapped[str] = mapped_column(String)  # BUY|SELL
    qty: Mapped[Decimal] = mapped_column(Numeric(20, 6), default=0)
    direction: Mapped[str] = mapped_column(String, default="UP")  # UP|DOWN
    trigger_price: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    limit_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    limit_timeout_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)
    product: Mapped[str] = mapped_column(String, default="DAY")
    is_paper: Mapped[bool] = mapped_column(Boolean, default=True)
    # PENDING|ARMED|TRIGGERED|FILLED|CANCELLED|FAILED
    state: Mapped[str] = mapped_column(String, default="ARMED", index=True)
    triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    triggered_ltp: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    order_id: Mapped[str | None] = mapped_column(String, nullable=True)
    extras: Mapped[dict] = mapped_column(JSONB, default=dict)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class Backtest(Base):
    __tablename__ = "backtests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    strategy_id: Mapped[str | None] = mapped_column(String, nullable=True)
    name: Mapped[str] = mapped_column(String)
    from_date: Mapped[date] = mapped_column(Date)
    to_date: Mapped[date] = mapped_column(Date)
    timeframe: Mapped[str] = mapped_column(String, default="5m")
    capital: Mapped[Decimal] = mapped_column(Numeric(20, 2), default=0)
    status: Mapped[str] = mapped_column(String, default="QUEUED")
    summary: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class StrategyInstance(Base):
    __tablename__ = "strategy_instances"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strategy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("strategies.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("broker_accounts.id"))
    symbols: Mapped[list[str]] = mapped_column(ARRAY(String))
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    state: Mapped[dict] = mapped_column(JSONB, default=dict)


class RiskProfile(Base):
    __tablename__ = "risk_profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("broker_accounts.id", ondelete="CASCADE"), unique=True)
    daily_loss_limit: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_drawdown_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 4), nullable=True)
    max_exposure: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_position_size: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_position_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 4), nullable=True)
