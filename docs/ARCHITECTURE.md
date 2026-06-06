# TradeAlgo — Production Trading Platform Architecture

> Automated US trading platform for **Stocks, ETFs, Futures, and Options**.
> Scalable · Modular · Secure · Low-latency · Multi-broker.

This document is the master reference covering deliverables 1–9. See
[`ROADMAP.md`](./ROADMAP.md) for the implementation roadmap and development
phases (deliverables 10 & 12), [`DATABASE.md`](./DATABASE.md) for the schema,
[`API.md`](./API.md) for the API design, and the `backend/` directory for
production-ready code (deliverable 11).

---

## 1. System Architecture

### 1.1 High-Level Topology

```
                         ┌───────────────────────────────────────┐
                         │           Clients (Web / API)         │
                         │  Next.js 14 (React/TS/Tailwind/TV)    │
                         └───────────────────┬───────────────────┘
                                             │ HTTPS / WSS
                                ┌────────────▼────────────┐
                                │     Nginx / ALB (TLS)    │
                                │  rate-limit · WAF · LB   │
                                └────────────┬────────────┘
                  ┌──────────────────────────┼──────────────────────────┐
                  │                           │                          │
        ┌─────────▼─────────┐      ┌──────────▼─────────┐     ┌──────────▼─────────┐
        │   API Gateway     │      │  WebSocket Gateway │     │   Auth Service     │
        │  FastAPI (REST)   │      │  FastAPI (WSS)     │     │  JWT · MFA · RBAC  │
        └─────────┬─────────┘      └──────────┬─────────┘     └──────────┬─────────┘
                  │                           │                          │
                  └─────────────┬─────────────┴──────────────┬──────────┘
                                │                            │
                    ┌───────────▼───────────┐    ┌───────────▼────────────┐
                    │     Redis (cache /     │    │   PostgreSQL (OLTP)    │
                    │   pub-sub / streams)   │    │  + TimescaleDB ext.    │
                    └───────────┬───────────┘    └────────────────────────┘
                                │  (message bus: Redis Streams / NATS)
        ┌───────────────────────┼───────────────────────────────────────────┐
        │                       │                       │                     │
┌───────▼───────┐   ┌───────────▼─────────┐  ┌──────────▼────────┐ ┌──────────▼────────┐
│ Market Data   │   │  Trading Engine     │  │  Risk Engine      │ │ Strategy Workers  │
│ Engine        │   │  (signal→risk→route)│  │  (pre/post trade) │ │ (plugin runtime)  │
│ (stream/cache)│   └───────────┬─────────┘  └──────────┬────────┘ └──────────┬────────┘
└───────┬───────┘               │                       │                     │
        │              ┌─────────▼──────────┐            │                     │
        │              │ Broker Abstraction │◄───────────┴─────────────────────┘
        │              │  Alpaca · IBKR ... │
        │              └─────────┬──────────┘
        ▼                        ▼
  Polygon/Databento        Broker APIs (REST/WS/TWS)
```

### 1.2 Core Design Principles

| Principle              | Implementation |
|------------------------|----------------|
| **Modularity**         | Every external integration sits behind an abstract interface (`BrokerBase`, `MarketDataProvider`, `NotificationChannel`, `AIProvider`). Strategies never import broker SDKs. |
| **Low latency**        | Async I/O end-to-end (FastAPI + `asyncio`), Redis hot cache, in-process order routing, connection pooling, no synchronous broker calls on the hot path. |
| **Scalability**        | Stateless API/WS pods behind a load balancer; horizontally scalable strategy workers; Redis Streams as the message bus; partitioned/time-series tables. |
| **Security**           | JWT + refresh rotation, TOTP MFA, RBAC, per-user encrypted broker credentials (KMS-backed envelope encryption), audit log, secrets in AWS Secrets Manager. |
| **Safety first**       | **No order reaches a broker without passing the Risk Engine.** Kill switch, broker-disconnect protection, market-halt detection. |
| **Observability**      | Structured JSON logs, Prometheus metrics, OpenTelemetry traces, CloudWatch dashboards & alarms. |

### 1.3 Process / Service Decomposition

The system runs as a set of independently deployable services that share the
same `app` package but boot different entrypoints:

| Service             | Entrypoint                          | Scaling axis            |
|---------------------|-------------------------------------|-------------------------|
| `api`               | `uvicorn app.main:app`              | RPS / users             |
| `ws-gateway`        | `app.websockets.server`             | concurrent connections  |
| `trading-engine`    | `app.trading_engine.worker`         | symbols / orders/sec    |
| `market-data`       | `app.market_data.worker`           | subscribed symbols      |
| `strategy-runner`   | `app.strategies.runner`            | active strategies       |
| `risk-monitor`      | `app.risk.monitor`                 | accounts                |
| `scheduler`         | `app.tasks.scheduler` (Celery beat) | jobs                    |
| `worker`            | Celery worker (backtests, AI, EOD)  | job queue depth         |

For an MVP all of these can run in a single process (`app.main` mounts them as
background tasks); in production each becomes its own container/ECS service.

---

## 2. Database Schema

Full DDL and ER notes live in [`DATABASE.md`](./DATABASE.md). Summary of the
core entities:

- **Identity & access**: `users`, `roles`, `user_roles`, `api_keys`, `mfa_secrets`, `audit_log`.
- **Brokerage**: `broker_accounts` (encrypted creds), `account_snapshots`, `positions`, `holdings`, `balances`, `margins`.
- **Trading**: `orders`, `order_legs` (multi-leg/options), `executions`, `trades`.
- **Strategy**: `strategies`, `strategy_versions`, `strategy_instances`, `signals`, `strategy_logs`.
- **Risk**: `risk_profiles`, `risk_limits`, `risk_events`, `kill_switch_state`.
- **Market data** (TimescaleDB hypertables): `bars`, `ticks`, `quotes`, `option_chains`, `greeks_snapshots`.
- **Backtesting**: `backtests`, `backtest_trades`, `backtest_metrics`.
- **Notifications**: `notification_channels`, `notifications`.

---

## 3. API Design

REST under `/api/v1`, realtime under `/ws`. Full reference in [`API.md`](./API.md).
Conventions: JSON, JWT bearer auth, cursor pagination, RFC-7807 problem
responses, idempotency keys on order placement, optimistic concurrency via
`ETag`/`updated_at`.

---

## 4. Backend Folder Structure

```
backend/
├── app/
│   ├── main.py                 # FastAPI app factory + router mount
│   ├── core/                   # config, db, redis, security, logging
│   ├── models/                 # SQLAlchemy ORM models
│   ├── schemas/                # Pydantic request/response models
│   ├── api/v1/endpoints/       # REST route handlers
│   ├── brokers/                # broker abstraction (base + adapters)
│   ├── market_data/            # providers, normalizer, cache, streaming
│   ├── trading_engine/         # signal→risk→route→execute pipeline
│   ├── risk/                   # risk engine, rules, kill switch
│   ├── strategies/             # plugin framework + built-in strategies
│   ├── options/                # greeks, chains, IV rank/percentile
│   ├── futures/                # rollover, margin, contract specs
│   ├── backtesting/            # engine + metrics + walk-forward + MC
│   ├── ai/                     # sentiment/news/earnings (OpenAI/Claude)
│   ├── notifications/          # email/telegram/discord/slack channels
│   ├── websockets/             # connection manager + handlers
│   └── tasks/                  # Celery tasks & scheduler
├── alembic/                    # migrations
├── tests/
├── pyproject.toml
├── requirements.txt
└── Dockerfile
```

See [`backend/README.md`](../backend/README.md) for the running version.

---

## 5. Frontend Folder Structure

The existing Next.js 14 app (`src/`) follows the App Router layout:

```
src/
├── app/                # routes (dashboard, trading, strategies, scanner...)
│   ├── (app)/          # authenticated shell + pages
│   ├── login/ register/ forgot-password/ reset-password/
├── components/         # UI library + domain widgets (charts, strategy builder)
├── hooks/              # data hooks (SWR), live market indices
├── services/           # API clients (REST + WS)
└── styles/
```

Frontend talks only to the backend API/WS — never directly to brokers or data
vendors. TradingView Lightweight Charts power the charting surfaces.

---

## 6. Broker Integration Architecture

```
        Trading Engine / Strategies / API
                       │  (uniform domain objects)
                       ▼
            ┌────────────────────────┐
            │      BrokerBase        │  abstract interface
            │  connect/auth/orders/  │
            │  positions/account/... │
            └───────────┬────────────┘
        ┌───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼
   AlpacaBroker    IBKRBroker      TradierBroker   TastytradeBroker
   (REST+WS)       (ib_insync)     (future)        (future)
```

- **`BrokerBase`** ([`backend/app/brokers/base.py`](../backend/app/brokers/base.py))
  defines the contract: `connect`, `disconnect`, `is_connected`,
  `get_account`, `get_positions`, `get_orders`, `place_order`, `cancel_order`,
  `modify_order`, `stream_account_updates`.
- **Domain models** ([`backend/app/brokers/models.py`](../backend/app/brokers/models.py))
  — `Order`, `Position`, `Account`, `Execution`, `Margin` — are broker-agnostic.
  Each adapter translates to/from its native payloads (anti-corruption layer).
- **`BrokerFactory`** ([`backend/app/brokers/factory.py`](../backend/app/brokers/factory.py))
  instantiates the right adapter from config; adding a broker = new file + register.
- **Resilience**: every adapter wraps an `AutoReconnect` mixin (exponential
  backoff, heartbeat, session refresh) and publishes `broker.connected` /
  `broker.disconnected` events the Risk Engine subscribes to.

Adding a broker requires **zero changes** to strategies or the trading engine.

---

## 7. Trading Engine Architecture

```
 Signal ──► Idempotency ──► Risk PRE-CHECK ──► Order Router ──► Broker
 (strat)     (dedupe)        (Risk Engine)      (smart route)    (adapter)
                                  │  reject                          │ fill
                                  ▼                                  ▼
                            risk_events                       Position Manager
                                                                    │
                                                          Risk POST-CHECK + P&L
                                                                    │
                                                              Notifications
```

Pipeline ([`backend/app/trading_engine/engine.py`](../backend/app/trading_engine/engine.py)):

1. **Signal intake** — from strategies, manual order entry, or AI suggestions.
2. **Normalization & idempotency** — dedupe via client order id / Redis key.
3. **Pre-trade risk** — `RiskEngine.validate(order)` (blocking; reject on fail).
4. **Order routing** — choose broker/account, translate to broker order, apply
   order-type semantics (Market/Limit/Stop/StopLimit/Bracket/OCO/Trailing).
5. **Execution** — submit via `BrokerBase.place_order`, persist `orders`/`executions`.
6. **Position management** — reconcile fills into `positions`, compute real-time P&L.
7. **Post-trade risk** — drawdown/exposure re-evaluation, may trigger kill switch.
8. **Fan-out** — WebSocket push + notifications + audit log.

Supports Stocks, ETFs, Futures, and multi-leg Options orders.

---

## 8. Risk Management Architecture

```
                 ┌──────────────────────────────────────────┐
                 │              RiskEngine                    │
                 │   validate(order) -> RiskDecision          │
                 └──────────────────────────────────────────┘
   PRE-TRADE rules (chain)            POST-TRADE / continuous monitors
   ─────────────────────────         ────────────────────────────────
   • MaxPositionSizeRule             • DailyLossLimitMonitor
   • MaxExposureRule                 • MaxDrawdownMonitor
   • BuyingPowerRule                 • ExposureMonitor
   • PerSymbolConcentration          • MarketHaltDetector
   • OrderSanityRule (price/qty)     • BrokerDisconnectGuard
   • KillSwitchRule (hard stop)      • → triggers KillSwitch
```

- **Chain of responsibility**: pre-trade rules
  ([`backend/app/risk/rules.py`](../backend/app/risk/rules.py)) each return
  `allow / reject / warn`; first hard reject stops the order.
- **Account-level limits**: daily loss, max drawdown, max exposure, max position
  size — stored per `risk_profile`, enforced live.
- **Trade-level**: stop-loss / take-profit / trailing-stop attached as protective
  legs (bracket) or monitored synthetically.
- **Emergency controls** ([`backend/app/risk/kill_switch.py`](../backend/app/risk/kill_switch.py)):
  - **Kill switch** — flatten/halt new orders globally or per account.
  - **Broker-disconnect protection** — on `broker.disconnected`, freeze new
    orders and optionally cancel resting orders.
  - **Market-halt detection** — LULD / trading-halt feed → block affected symbols.
- **Invariant**: the Order Router calls `RiskEngine.validate()` and refuses to
  route on anything but an `ALLOW`. No bypass path exists.

---

## 9. AWS Deployment Architecture

```
                         Route 53  ──►  CloudFront (static / Next.js)
                                            │
                                   ┌────────▼────────┐
                                   │       ALB        │  (TLS, WAF)
                                   └────────┬────────┘
                ┌───────────────────────────┼───────────────────────────┐
                │            ECS Fargate (or EKS) cluster                 │
                │  api · ws-gateway · trading-engine · market-data ·      │
                │  strategy-runner · risk-monitor · workers · scheduler   │
                └───────────────────────────┬───────────────────────────┘
        ┌──────────────┬─────────────────────┼───────────────┬────────────────┐
        ▼              ▼                     ▼               ▼                ▼
  RDS PostgreSQL  ElastiCache Redis    Secrets Mgr/KMS     S3            CloudWatch
  (Multi-AZ +     (cluster mode,       (broker creds,    (backtest      (logs/metrics/
   read replicas) pub-sub/streams)      JWT keys)         results, DR)   alarms) + X-Ray
```

| Requirement            | AWS realization |
|------------------------|-----------------|
| **High availability**  | Multi-AZ RDS, ElastiCache replication groups, ≥2 tasks/service across AZs, ALB health checks. |
| **Auto scaling**       | ECS service auto-scaling on CPU/RPS/queue depth; RDS read replicas; Redis cluster mode. |
| **Automatic backups**  | RDS automated snapshots + PITR, daily logical dumps to S3 (lifecycle to Glacier), Redis snapshots. |
| **Disaster recovery**  | Cross-region S3 replication, IaC (Terraform) for full rebuild, documented RTO/RPO, snapshot restore runbook. |
| **Security**           | Private subnets for data tier, SGs least-privilege, Secrets Manager + KMS, WAF on ALB, GuardDuty. |
| **Observability**      | CloudWatch dashboards/alarms → SNS → PagerDuty; OTel traces to X-Ray. |
| **CI/CD**              | GitHub Actions → build/test/scan → push ECR → deploy ECS (blue/green via CodeDeploy). |

IaC skeleton in [`infra/`](../infra/); pipeline in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

---

## Cross-cutting: Event Bus & Topics

Redis Streams (upgrade path: NATS/Kafka) carry the realtime fabric:

| Topic                  | Producer            | Consumers                              |
|------------------------|---------------------|----------------------------------------|
| `md.bars.{symbol}`     | Market Data Engine  | strategies, WS gateway, frontend       |
| `md.quotes.{symbol}`   | Market Data Engine  | trading engine, risk monitors          |
| `signals`              | Strategy runtime    | trading engine                         |
| `orders.events`        | Trading engine      | WS gateway, notifications, audit        |
| `positions.updates`    | Position manager    | risk monitors, WS gateway              |
| `risk.events`          | Risk engine         | notifications, kill switch, audit       |
| `broker.status`        | Broker adapters     | risk engine, ops dashboards            |

This is the seam that lets every component scale independently.
