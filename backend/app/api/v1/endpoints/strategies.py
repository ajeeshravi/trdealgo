"""Strategy catalog, custom-code validation, CRUD and run lifecycle."""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, require_roles
from app.core.database import get_db
from app.models.trading import Strategy, StrategyLog, StrategyRun
from app.strategies.registry import catalog, validate_custom_code

router = APIRouter(prefix="/strategies", tags=["strategies"])


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------
class ValidateRequest(BaseModel):
    code: str


class StrategyPayload(BaseModel):
    name: str
    description: str | None = None
    kind: str = "NO_CODE"
    symbols: list[str] = []
    timeframe_min: int | None = None
    capital: float = 0
    definition: dict = {}
    code: str | None = None
    risk: dict | None = None
    auto_start_on_login: bool = False
    auto_start_broker_account_id: str | None = None
    auto_start_is_paper: bool = True


class StartRunRequest(BaseModel):
    broker_account_id: str | None = None
    is_paper: bool = True


class AutoStartRequest(BaseModel):
    enabled: bool
    broker_account_id: str | None = None
    is_paper: bool = True


class PreferencesRequest(BaseModel):
    broker_account_ids: list[str] = []


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------
def _serialize(s: Strategy) -> dict:
    definition = s.definition or {}
    params = definition.get("params") or {}
    option_action = None
    opt_cfg = params.get("option_config") or {}
    legs = opt_cfg.get("legs") or []
    if legs and isinstance(legs[0], dict):
        option_action = legs[0].get("action")
    return {
        "id": str(s.id),
        "name": s.name,
        "description": s.description,
        "kind": s.kind,
        "status": s.status,
        "symbols": s.symbols or [],
        "timeframe_min": s.timeframe_min,
        "capital": float(s.capital or 0),
        "definition": definition,
        "code": s.code,
        "risk": s.risk or {},
        "instrument_class": definition.get("instrument_class"),
        "side": definition.get("side"),
        "option_action": option_action,
        "preferred_broker_account_ids": s.preferred_broker_account_ids or [],
        "auto_start_on_login": s.auto_start_on_login,
        "auto_start_broker_account_id": s.auto_start_broker_account_id,
        "auto_start_is_paper": s.auto_start_is_paper,
    }


def _serialize_run(r: StrategyRun) -> dict:
    return {
        "id": str(r.id),
        "status": r.status,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "stopped_at": r.stopped_at.isoformat() if r.stopped_at else None,
        "is_paper": r.is_paper,
        "pnl": float(r.pnl or 0),
        "realized_pnl": float(r.realized_pnl or 0),
    }


async def _get_owned(db: AsyncSession, strategy_id: str, user_id) -> Strategy:
    s = await db.get(Strategy, strategy_id)
    if s is None or s.user_id != user_id:
        raise HTTPException(404, "strategy not found")
    return s


def _apply_payload(s: Strategy, body: StrategyPayload) -> None:
    s.name = body.name
    s.description = body.description
    s.kind = body.kind
    s.symbols = body.symbols
    s.timeframe_min = body.timeframe_min
    s.capital = Decimal(str(body.capital or 0))
    s.definition = body.definition or {}
    s.code = body.code
    s.risk = body.risk or {}
    s.auto_start_on_login = body.auto_start_on_login
    s.auto_start_broker_account_id = body.auto_start_broker_account_id
    s.auto_start_is_paper = body.auto_start_is_paper


# ---------------------------------------------------------------------------
# Catalog / validation (unchanged contract)
# ---------------------------------------------------------------------------
@router.get("/catalog")
async def get_catalog(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
):
    return {"strategies": catalog()}


@router.post("/validate")
async def validate(
    body: ValidateRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
):
    ok, message = validate_custom_code(body.code)
    return {"valid": ok, "message": message}


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
@router.get("")
async def list_strategies(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(Strategy)
            .where(Strategy.user_id == current.user.id)
            .order_by(Strategy.created_at.desc())
        )
    ).scalars().all()
    return [_serialize(s) for s in rows]


@router.post("", status_code=201)
async def create_strategy(
    body: StrategyPayload,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = Strategy(user_id=current.user.id, status="DRAFT")
    _apply_payload(s, body)
    db.add(s)
    await db.flush()
    return _serialize(s)


@router.get("/{strategy_id}")
async def get_strategy(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    return _serialize(await _get_owned(db, strategy_id, current.user.id))


@router.put("/{strategy_id}")
async def update_strategy(
    strategy_id: str,
    body: StrategyPayload,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    _apply_payload(s, body)
    await db.flush()
    return _serialize(s)


@router.delete("/{strategy_id}", status_code=200)
async def delete_strategy(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    await db.delete(s)
    await db.flush()
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------
@router.post("/{strategy_id}/start", status_code=201)
async def start_strategy(
    strategy_id: str,
    body: StartRunRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    run = StrategyRun(
        strategy_id=s.id,
        broker_account_id=body.broker_account_id,
        is_paper=body.is_paper,
        status="PAPER" if body.is_paper else "LIVE",
        started_at=datetime.now(UTC),
    )
    db.add(run)
    s.status = run.status
    await db.flush()
    return _serialize_run(run)


@router.post("/{strategy_id}/stop/{run_id}")
async def stop_strategy(
    strategy_id: str,
    run_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    run = await db.get(StrategyRun, run_id)
    if run is None or run.strategy_id != s.id:
        raise HTTPException(404, "run not found")
    run.status = "STOPPED"
    run.stopped_at = datetime.now(UTC)
    # If no other live/paper run remains, mark the strategy stopped.
    others = (
        await db.execute(
            select(StrategyRun).where(
                StrategyRun.strategy_id == s.id,
                StrategyRun.status.in_(["LIVE", "PAPER", "PAUSED"]),
                StrategyRun.id != run.id,
            )
        )
    ).scalars().first()
    if others is None:
        s.status = "STOPPED"
    await db.flush()
    return _serialize_run(run)


@router.patch("/{strategy_id}/auto-start")
async def set_auto_start(
    strategy_id: str,
    body: AutoStartRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    s.auto_start_on_login = body.enabled
    s.auto_start_broker_account_id = body.broker_account_id
    s.auto_start_is_paper = body.is_paper
    await db.flush()
    return _serialize(s)


@router.patch("/{strategy_id}/preferences")
async def set_preferences(
    strategy_id: str,
    body: PreferencesRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    s.preferred_broker_account_ids = body.broker_account_ids
    await db.flush()
    return {"preferred_broker_account_ids": s.preferred_broker_account_ids or []}


@router.get("/{strategy_id}/runs")
async def list_runs(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    rows = (
        await db.execute(
            select(StrategyRun)
            .where(StrategyRun.strategy_id == s.id)
            .order_by(StrategyRun.started_at.desc().nullslast())
        )
    ).scalars().all()
    return [_serialize_run(r) for r in rows]


# ---------------------------------------------------------------------------
# Monitoring surfaces. Logs are produced by the strategy engine; indicators /
# plan-preview remain derived stubs (the detail page renders a calm state).
# ---------------------------------------------------------------------------
@router.get("/{strategy_id}/logs")
async def strategy_logs(
    strategy_id: str,
    limit: int = 300,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    rows = (
        await db.execute(
            select(StrategyLog)
            .where(StrategyLog.strategy_id == s.id)
            .order_by(StrategyLog.created_at.desc())
            .limit(min(limit, 1000))
        )
    ).scalars().all()
    return [
        {
            "ts": r.created_at.isoformat() if r.created_at else None,
            "kind": r.kind,
            "level": r.level,
            "message": r.message,
            "run_id": r.run_id,
            "signal_id": None,
            "order_id": None,
            "internal_symbol": r.internal_symbol,
            "meta": r.meta or {},
        }
        for r in rows
    ]


@router.get("/{strategy_id}/indicators")
async def strategy_indicators(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    await _get_owned(db, strategy_id, current.user.id)
    return []


@router.get("/{strategy_id}/symbols-resolved")
async def strategy_symbols_resolved(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_owned(db, strategy_id, current.user.id)
    return [
        {
            "display_symbol": sym,
            "internal_symbol": sym,
            "logical": False,
            "alias": None,
            "expiry": None,
            "days_to_expiry": None,
            "lot_size": None,
            "segment": None,
            "error": None,
        }
        for sym in (s.symbols or [])
    ]


def _plan_preview(s: Strategy) -> dict:
    definition = s.definition or {}
    params = definition.get("params") or {}

    def pick(key: str, default):
        return definition.get(key) or params.get(key) or default

    return {
        "trade_date": None,
        "section": pick("section", ""),
        "top_n": pick("top_n", 0),
        "min_confidence": pick("min_confidence", 0),
        "min_rr": pick("min_rr", 0),
        "risk_pct_per_trade": pick("risk_pct_per_trade", 0),
        "capital": float(s.capital or 0),
        "orders": [],
        "note": "Plan preview requires the end-of-day data pipeline, which is not "
        "wired up yet.",
    }


@router.get("/{strategy_id}/plan-preview")
async def strategy_plan_preview_get(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
    db: AsyncSession = Depends(get_db),
):
    return _plan_preview(await _get_owned(db, strategy_id, current.user.id))


@router.post("/{strategy_id}/plan-preview")
async def strategy_plan_preview_post(
    strategy_id: str,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
    db: AsyncSession = Depends(get_db),
):
    return _plan_preview(await _get_owned(db, strategy_id, current.user.id))
