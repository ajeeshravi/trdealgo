# API Design (Deliverable 3)

Base URL: `/api/v1` · Auth: `Authorization: Bearer <jwt>` (or `X-API-Key`).
Realtime: `wss://<host>/ws`. Errors follow RFC-7807 (`application/problem+json`).
Order placement requires an `Idempotency-Key` header.

## Auth & Users

| Method | Path | Description | Role |
|--------|------|-------------|------|
| POST | `/auth/register` | Create account | public |
| POST | `/auth/login` | Email/password → access+refresh (may require MFA step) | public |
| POST | `/auth/mfa/verify` | Submit TOTP to complete login | public |
| POST | `/auth/refresh` | Rotate refresh → new access | public |
| POST | `/auth/logout` | Revoke refresh token | any |
| GET  | `/users/me` | Current user + roles | any |
| POST | `/users/me/mfa/enable` | Begin TOTP enrollment (returns provisioning URI) | any |
| POST | `/users/me/mfa/confirm` | Confirm TOTP | any |
| GET/POST/DELETE | `/users/me/api-keys` | Manage API keys | any |
| GET/POST/PATCH/DELETE | `/admin/users` | User & role management | admin |

## Broker Accounts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/brokers` | List supported brokers + capabilities |
| GET/POST | `/broker-accounts` | List / link a broker account (creds encrypted) |
| POST | `/broker-accounts/{id}/connect` | Connect & start session |
| POST | `/broker-accounts/{id}/disconnect` | Disconnect |
| GET | `/broker-accounts/{id}` | Status, balances, margin |
| GET | `/broker-accounts/{id}/positions` | Live positions |
| GET | `/broker-accounts/{id}/holdings` | Holdings |
| GET | `/broker-accounts/{id}/pnl` | Real-time P&L |

## Trading

| Method | Path | Description |
|--------|------|-------------|
| POST | `/orders` | Place order (market/limit/stop/stop_limit/trailing/bracket/oco). **Idempotency-Key required.** Runs risk pre-check. |
| GET | `/orders` | List/filter orders (cursor paginated) |
| GET | `/orders/{id}` | Order detail + executions |
| PATCH | `/orders/{id}` | Modify (replace) order |
| DELETE | `/orders/{id}` | Cancel order |
| POST | `/orders/multi-leg` | Multi-leg options/spread order |
| GET | `/positions` | Aggregate positions across accounts |
| POST | `/positions/{symbol}/close` | Flatten a position |

### Order request example

```json
POST /api/v1/orders
Idempotency-Key: 8f3c...
{
  "account_id": "uuid",
  "symbol": "AAPL",
  "asset_class": "stock",
  "side": "buy",
  "order_type": "bracket",
  "qty": 100,
  "limit_price": 190.50,
  "take_profit": { "limit_price": 200.00 },
  "stop_loss":   { "stop_price": 185.00 },
  "tif": "day",
  "strategy_instance_id": null
}
```

## Market Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/market-data/bars?symbol=&timeframe=&start=&end=` | Historical OHLCV |
| GET | `/market-data/quote?symbol=` | Latest quote |
| GET | `/market-data/ticks?symbol=&start=&end=` | Tick data |
| GET | `/market-data/snapshot?symbols=` | Multi-symbol snapshot |
| POST | `/market-data/replay` | Start a data replay session (backtest/sim) |

## Options & Futures

| Method | Path | Description |
|--------|------|-------------|
| GET | `/options/{underlying}/chain?expiry=` | Option chain w/ greeks & OI |
| GET | `/options/{underlying}/iv-rank` | IV rank & percentile |
| GET | `/options/strategies/build` | Build defined-risk structures (IC, spreads...) |
| GET | `/futures/contracts?root=ES` | Contract list / front month |
| GET | `/futures/{root}/rollover` | Rollover schedule & status |

## Strategies

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/strategies` | List / create strategy |
| GET | `/strategies/catalog` | Built-in plugin catalog + param schemas |
| POST | `/strategies/{id}/versions` | New version (config or custom code) |
| POST | `/strategies/validate` | Validate custom strategy code (sandboxed) |
| POST | `/strategy-instances` | Deploy instance to an account/symbols |
| POST | `/strategy-instances/{id}/enable` · `/disable` | Toggle |
| GET | `/strategy-instances/{id}/logs` | Logs/signals |

## Risk

| Method | Path | Description |
|--------|------|-------------|
| GET/PUT | `/risk/profiles/{account_id}` | Read/update risk limits |
| GET | `/risk/events` | Risk event feed |
| POST | `/risk/kill-switch` | Activate/deactivate (scope: global/account) |
| GET | `/risk/status` | Live risk posture (exposure, drawdown, halts) |

## Backtesting

| Method | Path | Description |
|--------|------|-------------|
| POST | `/backtests` | Queue a backtest (sync metrics via callback/WS) |
| GET | `/backtests/{id}` | Status + metrics |
| GET | `/backtests/{id}/trades` | Trade list / equity curve |
| POST | `/backtests/{id}/walk-forward` · `/monte-carlo` | Advanced analyses |

## AI

| Method | Path | Description |
|--------|------|-------------|
| POST | `/ai/sentiment` | Market sentiment for symbols |
| POST | `/ai/news` | News analysis/summary |
| POST | `/ai/earnings` | Earnings analysis |
| POST | `/ai/opportunities` | Trade-opportunity scan (advisory only) |
| POST | `/ai/risk-assessment` | Narrative risk assessment of a position/portfolio |

> AI endpoints are **advisory**. Any order derived from AI still passes the Risk Engine.

## Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET/POST/DELETE | `/notifications/channels` | Manage email/telegram/discord/slack |
| POST | `/notifications/test` | Send a test message |
| GET | `/notifications` | In-app notification feed |

## Scanners

| Method | Path | Description |
|--------|------|-------------|
| GET | `/scanner/stocks?filters=` | Stock scanner |
| GET | `/scanner/options?filters=` | Options scanner (IV rank, OI, ...) |
| GET | `/scanner/futures?filters=` | Futures scanner |

## WebSocket protocol (`/ws`)

Client authenticates with a short-lived WS ticket, then subscribes:

```json
{ "type": "subscribe", "channels": ["quotes:AAPL", "orders", "positions", "risk"] }
```

Server frames:

```json
{ "type": "quote", "symbol": "AAPL", "data": { "bid": 190.1, "ask": 190.2, "ts": "..." } }
{ "type": "order", "data": { "id": "...", "status": "filled", ... } }
{ "type": "risk",  "data": { "rule": "daily_loss_limit", "decision": "halt" } }
```

## Conventions

- **Pagination**: `?limit=&cursor=` → `{ "items": [...], "next_cursor": "..." }`.
- **Idempotency**: `Idempotency-Key` on POST `/orders`; replays return the original result.
- **Versioning**: URI-versioned (`/api/v1`); additive changes only within a version.
- **Rate limiting**: token bucket per API key (Redis); `429` + `Retry-After`.
- **Errors**: `{ "type", "title", "status", "detail", "instance" }`.
