"""Brokerage, trading, strategy and risk ORM models."""
from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
    Boolean,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    String,
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
    paper: Mapped[bool] = mapped_column(Boolean, default=True)
    credentials_enc: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String, default="disconnected")


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
    config: Mapped[dict] = mapped_column(JSONB, default=dict)


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
