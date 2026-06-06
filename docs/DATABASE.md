# Database Schema (Deliverable 2)

PostgreSQL 15 + **TimescaleDB** (for `bars`/`ticks`/`quotes` hypertables).
Redis is used for hot cache, pub/sub, streams, rate limiting, and idempotency
keys — not durable storage.

Conventions: `id` = `BIGINT GENERATED ALWAYS AS IDENTITY` (or UUID for
externally-exposed entities), `created_at`/`updated_at timestamptz`, soft delete
via `deleted_at` where relevant, money as `NUMERIC(20,6)`, all timestamps UTC.

## ER Overview

```
users ─┬─< user_roles >─ roles
       ├─< api_keys
       ├─< mfa_secrets
       ├─< broker_accounts ─┬─< positions
       │                    ├─< holdings
       │                    ├─< balances
       │                    ├─< margins
       │                    └─< account_snapshots
       ├─< strategies ─< strategy_versions
       │        └─< strategy_instances ─┬─< signals
       │                                └─< strategy_logs
       ├─< orders ─┬─< order_legs
       │           └─< executions ─< trades
       ├─< risk_profiles ─< risk_limits
       ├─< risk_events
       ├─< backtests ─┬─< backtest_trades
       │              └─< backtest_metrics
       └─< notifications ; notification_channels
market data (hypertables): bars, ticks, quotes, option_chains, greeks_snapshots
audit_log (append-only)
```

## Core DDL (abridged)

```sql
-- ============ Identity & Access ============
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,            -- argon2id
    full_name     TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    id   SMALLINT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL              -- 'admin' | 'trader' | 'viewer'
);

CREATE TABLE user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id SMALLINT REFERENCES roles(id),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE mfa_secrets (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc  BYTEA NOT NULL,            -- TOTP secret, KMS-encrypted
    recovery    TEXT[] NOT NULL DEFAULT '{}',
    confirmed_at TIMESTAMPTZ
);

CREATE TABLE api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    prefix      TEXT NOT NULL,             -- shown to user
    hash        TEXT NOT NULL,             -- sha256 of secret
    scopes      TEXT[] NOT NULL DEFAULT '{}',
    last_used_at TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Brokerage ============
CREATE TABLE broker_accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    broker        TEXT NOT NULL,           -- 'alpaca' | 'ibkr' | ...
    alias         TEXT,
    paper         BOOLEAN NOT NULL DEFAULT true,
    credentials_enc BYTEA NOT NULL,        -- envelope-encrypted JSON
    status        TEXT NOT NULL DEFAULT 'disconnected',
    last_connected_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, broker, alias)
);

CREATE TABLE positions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id    UUID REFERENCES broker_accounts(id) ON DELETE CASCADE,
    symbol        TEXT NOT NULL,
    asset_class   TEXT NOT NULL,           -- stock|etf|future|option
    qty           NUMERIC(20,6) NOT NULL,
    avg_price     NUMERIC(20,6) NOT NULL,
    market_price  NUMERIC(20,6),
    unrealized_pnl NUMERIC(20,6),
    realized_pnl  NUMERIC(20,6) DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, symbol)
);

CREATE TABLE balances (
    account_id    UUID PRIMARY KEY REFERENCES broker_accounts(id) ON DELETE CASCADE,
    cash          NUMERIC(20,6) NOT NULL,
    equity        NUMERIC(20,6) NOT NULL,
    buying_power  NUMERIC(20,6) NOT NULL,
    maintenance_margin NUMERIC(20,6),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_snapshots (        -- time series for equity curve
    account_id  UUID REFERENCES broker_accounts(id) ON DELETE CASCADE,
    ts          TIMESTAMPTZ NOT NULL,
    equity      NUMERIC(20,6) NOT NULL,
    cash        NUMERIC(20,6) NOT NULL,
    pnl_day     NUMERIC(20,6),
    PRIMARY KEY (account_id, ts)
);

-- ============ Trading ============
CREATE TABLE orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_order_id TEXT UNIQUE,           -- idempotency
    account_id    UUID REFERENCES broker_accounts(id),
    strategy_instance_id UUID,
    symbol        TEXT NOT NULL,
    asset_class   TEXT NOT NULL,
    side          TEXT NOT NULL,           -- buy|sell
    order_type    TEXT NOT NULL,           -- market|limit|stop|stop_limit|trailing_stop
    tif           TEXT NOT NULL DEFAULT 'day',
    qty           NUMERIC(20,6) NOT NULL,
    limit_price   NUMERIC(20,6),
    stop_price    NUMERIC(20,6),
    trail_percent NUMERIC(10,4),
    parent_order_id UUID REFERENCES orders(id),  -- bracket/OCO
    bracket_type  TEXT,                    -- entry|take_profit|stop_loss
    status        TEXT NOT NULL DEFAULT 'new',    -- new|accepted|partially_filled|filled|canceled|rejected
    broker_order_id TEXT,
    filled_qty    NUMERIC(20,6) DEFAULT 0,
    avg_fill_price NUMERIC(20,6),
    submitted_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (account_id, status);
CREATE INDEX ON orders (strategy_instance_id);

CREATE TABLE order_legs (                 -- multi-leg options/futures spreads
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    UUID REFERENCES orders(id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,            -- OCC option symbol
    side        TEXT NOT NULL,
    ratio       INT NOT NULL DEFAULT 1,
    strike      NUMERIC(20,6),
    expiry      DATE,
    right       TEXT                      -- call|put
);

CREATE TABLE executions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    UUID REFERENCES orders(id) ON DELETE CASCADE,
    exec_id     TEXT,                     -- broker fill id
    qty         NUMERIC(20,6) NOT NULL,
    price       NUMERIC(20,6) NOT NULL,
    fee         NUMERIC(20,6) DEFAULT 0,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trades (                     -- closed round-trips for analytics
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  UUID REFERENCES broker_accounts(id),
    strategy_instance_id UUID,
    symbol      TEXT NOT NULL,
    qty         NUMERIC(20,6) NOT NULL,
    entry_price NUMERIC(20,6) NOT NULL,
    exit_price  NUMERIC(20,6),
    pnl         NUMERIC(20,6),
    opened_at   TIMESTAMPTZ NOT NULL,
    closed_at   TIMESTAMPTZ
);

-- ============ Strategy ============
CREATE TABLE strategies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- momentum|mean_reversion|iron_condor|...
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE strategy_versions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_id UUID REFERENCES strategies(id) ON DELETE CASCADE,
    version     INT NOT NULL,
    config      JSONB NOT NULL,           -- entry/exit/risk/sizing params
    code        TEXT,                     -- optional custom python
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (strategy_id, version)
);

CREATE TABLE strategy_instances (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_version_id UUID REFERENCES strategy_versions(id),
    account_id  UUID REFERENCES broker_accounts(id),
    symbols     TEXT[] NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    state       JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE signals (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    strategy_instance_id UUID REFERENCES strategy_instances(id),
    symbol      TEXT NOT NULL,
    action      TEXT NOT NULL,           -- enter_long|exit|...
    strength    NUMERIC(6,4),
    payload     JSONB,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE strategy_logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    strategy_instance_id UUID REFERENCES strategy_instances(id),
    level       TEXT NOT NULL,
    message     TEXT NOT NULL,
    context     JSONB,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Risk ============
CREATE TABLE risk_profiles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID UNIQUE REFERENCES broker_accounts(id) ON DELETE CASCADE,
    daily_loss_limit   NUMERIC(20,6),
    max_drawdown_pct   NUMERIC(6,4),
    max_exposure       NUMERIC(20,6),
    max_position_size  NUMERIC(20,6),
    max_position_pct   NUMERIC(6,4),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE risk_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  UUID REFERENCES broker_accounts(id),
    rule        TEXT NOT NULL,
    decision    TEXT NOT NULL,           -- reject|warn|halt
    detail      JSONB,
    ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kill_switch_state (
    scope       TEXT PRIMARY KEY,        -- 'global' or account uuid
    active      BOOLEAN NOT NULL DEFAULT false,
    reason      TEXT,
    activated_by TEXT,
    activated_at TIMESTAMPTZ
);

-- ============ Backtesting ============
CREATE TABLE backtests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id),
    strategy_version_id UUID REFERENCES strategy_versions(id),
    symbols     TEXT[] NOT NULL,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    initial_capital NUMERIC(20,6) NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE backtest_metrics (
    backtest_id UUID PRIMARY KEY REFERENCES backtests(id) ON DELETE CASCADE,
    cagr NUMERIC, sharpe NUMERIC, sortino NUMERIC,
    max_drawdown NUMERIC, win_rate NUMERIC, profit_factor NUMERIC,
    total_return NUMERIC, num_trades INT
);

CREATE TABLE backtest_trades (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    backtest_id UUID REFERENCES backtests(id) ON DELETE CASCADE,
    symbol TEXT, side TEXT, qty NUMERIC,
    entry_ts TIMESTAMPTZ, entry_price NUMERIC,
    exit_ts TIMESTAMPTZ, exit_price NUMERIC, pnl NUMERIC
);

-- ============ Notifications & Audit ============
CREATE TABLE notification_channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,           -- email|telegram|discord|slack
    config_enc  BYTEA NOT NULL,
    events      TEXT[] NOT NULL DEFAULT '{}',
    enabled     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE notifications (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    event TEXT NOT NULL, title TEXT, body TEXT,
    delivered BOOLEAN DEFAULT false,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (                  -- append-only
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
    ip INET, detail JSONB, ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Market Data (TimescaleDB hypertables) ============
CREATE TABLE bars (
    symbol TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
    timeframe TEXT NOT NULL,              -- 1m|5m|1h|1d
    open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC, volume NUMERIC,
    vwap NUMERIC, trade_count INT,
    PRIMARY KEY (symbol, timeframe, ts)
);
SELECT create_hypertable('bars', 'ts', chunk_time_interval => INTERVAL '7 days');

CREATE TABLE quotes (
    symbol TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
    bid NUMERIC, bid_size NUMERIC, ask NUMERIC, ask_size NUMERIC,
    PRIMARY KEY (symbol, ts)
);
SELECT create_hypertable('quotes', 'ts', chunk_time_interval => INTERVAL '1 day');

CREATE TABLE option_chains (
    underlying TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL,
    occ_symbol TEXT NOT NULL, expiry DATE, strike NUMERIC, right TEXT,
    bid NUMERIC, ask NUMERIC, last NUMERIC, volume NUMERIC, open_interest NUMERIC,
    iv NUMERIC, delta NUMERIC, gamma NUMERIC, theta NUMERIC, vega NUMERIC, rho NUMERIC,
    PRIMARY KEY (occ_symbol, ts)
);
SELECT create_hypertable('option_chains', 'ts', chunk_time_interval => INTERVAL '1 day');
```

### Retention / compression (Timescale)

```sql
ALTER TABLE bars SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol');
SELECT add_compression_policy('bars', INTERVAL '30 days');
SELECT add_retention_policy('quotes', INTERVAL '90 days');
```
