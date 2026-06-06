"""Celery app for background jobs: backtests, EOD analytics, AI scans, snapshots."""
from __future__ import annotations

from celery import Celery

from app.core.config import settings

celery_app = Celery(
    "tradealgo",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
)

# Periodic jobs (Celery beat).
celery_app.conf.beat_schedule = {
    "account-snapshots": {
        "task": "app.tasks.jobs.snapshot_accounts",
        "schedule": 300.0,  # every 5 min
    },
    "eod-analytics": {
        "task": "app.tasks.jobs.run_eod_analytics",
        "schedule": 60.0 * 60,  # hourly; gate to market close internally
    },
}
