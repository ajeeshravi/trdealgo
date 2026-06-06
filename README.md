# TradeAlgo — Production Automated US Trading Platform

A scalable, modular, secure, low-latency automated trading platform for the US
market supporting **Stocks, ETFs, Futures, and Options**. Multi-broker
(Alpaca + IBKR today; Tradier/Tastytrade/TradeStation/Schwab planned), with a
plugin strategy framework, institutional-grade risk controls, backtesting, and
AI-assisted (advisory) analysis.

> ⚠️ Trading involves real financial risk. This software is provided as-is and
> is **not investment advice**. Default everything to **paper** trading and
> understand each broker's terms before going live.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, Next.js 14, TypeScript, Tailwind CSS, TradingView (Lightweight Charts) |
| Backend | Python, FastAPI, WebSockets, async, Celery |
| Data | PostgreSQL + TimescaleDB, Redis |
| Infra | Docker, AWS (ECS/RDS/ElastiCache/S3/CloudWatch), Nginx, GitHub Actions CI/CD |
| AI | OpenAI + Anthropic Claude (advisory only) |

## Repository layout

```
.
├── src/                # Next.js frontend (existing app)
├── backend/            # FastAPI backend (see backend/README.md)
├── docs/               # Architecture, DB schema, API design, roadmap
├── infra/              # Nginx config + Terraform (AWS)
├── docker-compose.yml  # Local dev stack (db, redis, backend, worker, frontend)
└── .github/workflows/  # CI/CD
```

## Documentation (the 12 deliverables)

| # | Deliverable | Where |
|---|-------------|-------|
| 1 | System architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §1 |
| 2 | Database schema | [`docs/DATABASE.md`](docs/DATABASE.md) |
| 3 | API design | [`docs/API.md`](docs/API.md) |
| 4 | Backend folder structure | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4 · `backend/` |
| 5 | Frontend folder structure | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5 · `src/` |
| 6 | Broker integration architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6 · `backend/app/brokers/` |
| 7 | Trading engine architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7 · `backend/app/trading_engine/` |
| 8 | Risk management architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8 · `backend/app/risk/` |
| 9 | AWS deployment architecture | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9 · `infra/terraform/` |
| 10 | Implementation roadmap | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| 11 | Production-ready code | `backend/` (runnable; tests pass) |
| 12 | Dev phases (MVP→enterprise) | [`docs/ROADMAP.md`](docs/ROADMAP.md) |

## Quick start

```bash
cp backend/.env.example backend/.env     # set secrets (JWT, broker, AI keys)
docker compose up --build
# Frontend  → http://localhost:3000
# API docs  → http://localhost:8000/docs
```

See [`backend/README.md`](backend/README.md) for backend-only setup, tests, and
how to add brokers/strategies.

## Core safety guarantee

No order reaches a broker without passing the Risk Engine — including manual,
strategy-generated, and AI-suggested orders. The kill switch, broker-disconnect
protection, and market-halt detection are wired into the order path and covered
by tests (`backend/tests/test_risk_engine.py`).
