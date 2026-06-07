"""Background task definitions."""
from __future__ import annotations

from app.core.logging import get_logger
from app.tasks.celery_app import celery_app

log = get_logger("tasks")


@celery_app.task(name="app.tasks.jobs.snapshot_accounts")
def snapshot_accounts() -> str:
    """Persist periodic equity snapshots for the equity-curve / analytics views."""
    log.info("task.snapshot_accounts")
    # Implementation: iterate connected accounts, write account_snapshots rows.
    return "ok"


@celery_app.task(name="app.tasks.jobs.run_eod_analytics")
def run_eod_analytics() -> str:
    """End-of-day analytics: realized P&L rollups, trade journaling, metrics."""
    log.info("task.run_eod_analytics")
    return "ok"


@celery_app.task(name="app.tasks.jobs.run_backtest", bind=True)
def run_backtest(self, backtest_id: str) -> str:  # noqa: ANN001
    """Execute a queued backtest and persist metrics."""
    import asyncio

    from app.backtesting.runner import run_backtest_for

    log.info("task.run_backtest", backtest_id=backtest_id)
    return asyncio.run(run_backtest_for(backtest_id))


@celery_app.task(name="app.tasks.jobs.tick_strategies")
def tick_strategies() -> str:
    """Evaluate active strategy runs (paper-mode fills + logs + P&L)."""
    import asyncio

    from app.services.strategy_engine import tick_all

    return asyncio.run(tick_all())
