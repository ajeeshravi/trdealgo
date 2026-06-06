# TradeAlgo Backend (FastAPI)

Production-grade backend for the automated US trading platform — Stocks, ETFs,
Futures, Options. Multi-broker, risk-gated, plugin strategies, backtesting, AI
advisory. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the full design.

## Layout

```
app/
├── main.py            # FastAPI factory + WS gateway + Redis→WS bridge
├── core/              # config, database (async SQLAlchemy), redis, security, logging
├── models/            # ORM models (users, broker accounts, orders, strategies, risk)
├── schemas/           # Pydantic request/response models
├── api/v1/endpoints/  # auth, brokers, orders, risk, strategies, market_data, ai
├── brokers/           # BrokerBase + Alpaca + IBKR adapters + factory (extensible)
├── market_data/       # provider interface + Alpaca/Polygon + caching engine
├── trading_engine/    # signal→risk→route→execute pipeline + position manager
├── risk/              # rule chain, RiskEngine (mandatory gate), kill switch
├── strategies/        # plugin framework + built-ins (equity & options) + registry
├── options/           # Black-Scholes greeks, IV rank/percentile, chain builders
├── futures/           # contract specs, rollover, margin
├── backtesting/       # event-driven engine, metrics, walk-forward, Monte Carlo
├── ai/                # OpenAI/Anthropic providers + advisory analysis
├── notifications/     # email/telegram/discord/slack channels + router
├── services/          # broker session manager
├── websockets/        # connection manager
└── tasks/             # Celery app + jobs
```

## Quick start (local)

From the repo root (recommended — brings up Postgres+Timescale, Redis, API, frontend):

```bash
cp backend/.env.example backend/.env   # then edit secrets
docker compose up --build
# API:   http://localhost:8000/docs
# WS:    ws://localhost:8000/ws
# Front: http://localhost:3000
```

Backend only (needs Postgres + Redis running):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
alembic revision --autogenerate -m "init"   # first time
alembic upgrade head
python -m scripts.seed                       # roles (+ optional admin via env)
uvicorn app.main:app --reload
```

## Tests

```bash
pytest -q          # risk engine, greeks, IV, backtester
ruff check app     # lint
```

The risk-engine suite proves the core safety invariant: kill switch, broker
disconnect, halts, daily-loss, drawdown, position-size, exposure, and
buying-power all block orders.

## The safety invariant

Every order — manual, strategy, or AI-derived — is submitted through
`TradingEngine.submit()`, which calls `RiskEngine.validate()` **before** routing
to any broker and refuses to proceed on a reject. There is no bypass path.

## Adding a broker

1. Implement `BrokerBase` in `app/brokers/<name>.py` (translate to/from the
   domain models in `app/brokers/models.py`).
2. Register it in `app/brokers/factory.py`.

No changes to strategies, the trading engine, or risk are required.

## Adding a strategy

Subclass `StrategyBase` (`app/strategies/base.py`), implement `generate()`,
declare `key`/`param_schema`, and register it in `app/strategies/registry.py`.
User-supplied custom code is validated via `validate_custom_code()` before use.
