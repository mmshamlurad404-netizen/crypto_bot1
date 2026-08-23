# Implementation Plan — Cryptohopper feature parity

Updated: 2026-08-21
Basis: `.context/gap-analysis.md` priority ranking. Scope = on-prem, Nobitex-only, safety-first (DRY_RUN / TRADING_ENABLED stay defaulted to safe).

## Phase 1 — Validate & instrument what we already trade (do first)

### P1-1 Backtester — DONE (2026-08-22)
- `src/backtest/engine.ts`: replays historical bars through the real `HybridStrategy` + risk gates on an injectable clock; paper `PortfolioManager`; fills at bar close; day-roll maintains `prev_day_equity`.
- `src/backtest/data.ts`: `loadHistory` pages `/market/udf/history` (exchange retains ~500 bars: 60m≈21d, 240m≈83d); `loadSentimentFile` for JSONL.
- `src/backtest/run.ts` CLI: `--symbol/--days/--resolution/--sentiment/--sentiment-file/--start-equity/--json/--verbose`; warns on retention-short spans; requires a sentiment source.
- Tests `tests/backtest.test.ts` (6) + clock-injection refactor (RiskManager/PortfolioManager/SentimentEngine accept `now`); 34/34 pass; verified against live BTC-RLS history.
- Refactors: `toUdfSymbol` exported from priceFeed; `udfHistory` added to NobitexClient.

### P1-2 Performance analytics + trade history export — DONE (2026-08-22)
- `src/report/metrics.ts`: `computeMetrics` from AuditDb (range-filtered, default 30d) — win rate, profit factor, net PnL, avg win/loss (abs + % of start equity), return, max drawdown, Sharpe, avg exposure.
- `src/export/trades.ts` CLI: `--kind trades|positions`, `--from/--to` (UTC dates), CSV to stdout, EPIPE-safe; cleaned rial number formatting.
- `DailyReporter` now emits a "Performance (last 30d)" section.
- DB: `closedPositionsBetween`, `snapshotsBetween` + indexes on positions(close_ts) and portfolio_snapshots(ts).
- Tests `tests/metrics.test.ts` (5); full suite 39/39; smoke-tested CSV export on a seeded DB.

### P1-3 Trailing stop-loss / trailing take-profit
- `src/risk/manager.ts`: track `trailingStopPct` and optional `trailingTpPct` per position; on each tick update activation price if unrealized PnL exceeds activation threshold (e.g., +X% from entry), then ratchet.
- Config: `TRAILING_STOP_PCT`, `TRAILING_STOP_ACTIVATE_PCT`, `TRAILING_TP_PCT`, `TRAILING_TP_ACTIVATE_PCT` in `.env.example` + config.ts schema.
- Replace/augment `checkStopLoss` with `checkTrailingStops`; keep fixed SL as floor.
- Tests: `tests/risk.test.ts` trailing ratchet scenarios (activation, pullback, never-activated).

### P1-4 DCA (averaging down)
- New `src/strategy/dca.ts` + config `DCA_LEVELS` (JSON array of `{belowPct, buyPct}`), `DCA_MAX_ORDERS_PER_POSITION`, `DCA_ENABLED`.
- On tick, for open position: if price < entry × (1 − belowPct) and a fresh level not yet consumed, augment position via normal risk gates (skip open-position gate only for DCA buys).
- DCA buys recorded as `orders.kind = 'dca'`; position avg entry recomputed in `portfolio.applyTrade`.
- Tests: `tests/dca.test.ts` ladder descent/augment/avg-price recompute.

### P1-5 Trigger engine (rule DSL)
- New `src/triggers/engine.ts`: declarative rules read from env/JSON (e.g., `TRIGGER_RSI_OVERSOLD_NOTIFY`): condition (price below, RSI cross, sentiment above, volume spike) → action (notify / buy / sell / halt).
- Registry of predicates + actions; engine evaluated in `tick` after price poll, before strategy.
- Replaces hard-coded exit shortcuts over time; first version: notify + manual overrides.
- Tests: `tests/triggers.test.ts` condition→action mapping.

## Phase 2 — Generalize strategy & signal intake

### P2-1 Strategy DSL + config pools
- `src/strategy/dsl.ts`: declarative strategy schema (JSON): entry/exit composed of indicator nodes (RSI, volatility, price vs MA, sentiment) with and/or combinators; compile to `evaluate`-compatible object.
- Add MA (SMA/EMA) indicators to `src/indicators.ts` (needed by DSL and backtester realism).
- `src/config/pools.ts`: multiple named configs; assign per-symbol or schedule rotation (mimics Config Pools).
- Keep existing hybrid as the default compiled strategy so behavior is unchanged until user opts in.

### P2-2 TradingView webhook endpoint
- `src/sentiment/server.ts`: add `POST /api/v1/tradingview` (Bearer auth) accepting TradingView alert payloads; map alert message/`{{strategy.order.action}}` → BUY/SELL intent that flows through normal risk gates.
- Document webhook URL/format in README; sample script `scripts/feed_tradingview.sh`.

### P2-3 Signals framework
- `src/signals/`: generic subscriber model (source: sentiment feed, TradingView, manual API, scheduled) each yielding a `SignalIntent`; strategy consumes unified intents. Refactor sentiment into a subscriber.
- `Signals` replace `POST /api/v1/sentiment`-only flow; keep API compatible.

## Phase 3 — Stretch (only if earlier phases land clean)

- Short selling via Nobitex margin API (`/v2/margin/...`): new risk model, requires separate config + heavy testing; default OFF.
- Market making / arbitrage: orderbook depth + maker fills; highest complexity, lowest priority.
- Multi-bot orchestration: run N configs in one process (Bulk Bot Manager analogue).
- AI strategy: optional LLM advisor consuming indicators + sentiment, emitting weights (user supplies own key via `USER_LLM_*`, per no-read-llm-env rule).

## Explicitly NOT planned
Multi-exchange abstraction, marketplace/social/mobile/charting SaaS, copy trading, taxes reporting.

## Verification per phase
- Unit tests for every new module (node:test, in-memory DB).
- `npm run typecheck` clean; `npm run build` clean.
- Backtester + export validated against a 90-day live Nobitex history pull.
- All new behavior gated behind env flags defaulting to safe/off.
