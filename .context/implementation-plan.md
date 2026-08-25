# Implementation Plan — Cryptohopper feature parity

Updated: 2026-08-25
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

### P1-3 Trailing stop-loss / trailing take-profit — DONE (2026-08-23)
- `src/risk/manager.ts`: `checkTrailingStops` keeps per-position peak + armed flags; stop arms at `TRAILING_STOP_ACTIVATE_PCT` above entry, TP arms at `TRAILING_TP_ACTIVATE_PCT`; armed TP supersedes the fixed take-profit in `HybridStrategy` so winners run; state resets on position change/close.
- Config: `TRAILING_STOP_PCT`, `TRAILING_STOP_ACTIVATE_PCT`, `TRAILING_TP_PCT`, `TRAILING_TP_ACTIVATE_PCT` added to config.ts schema (Zod, defaults safe: stops/TP 0 = disabled) + `.env.example`; wired into `index.ts` and backtest engine.
- Strategy `src/strategy/hybrid.ts`: trailing checks run between stop-loss and fixed take-profit; fixed TP skipped while trailing TP armed.
- Tests `tests/risk.test.ts`: 5 trailing scenarios (no-hit before activation, arm+ratchet, TP pullback exit, supersede fixed TP, state reset on close/re-entry); suite 44/44, typecheck + build clean.

### P1-4 DCA (averaging down) — DONE (2026-08-24)
- `src/strategy/dca.ts`: `DcaLadder` — levels sorted by `belowPct`, consumed in order via a per-position cursor; gap-downs still consume one level per tick; `maxOrders` caps fills.
- Config: `DCA_ENABLED` (default false), `DCA_LEVELS` (JSON `[{belowPct,buyPct}]`, validated/sorted), `DCA_MAX_ORDERS_PER_POSITION`; wired through `index.ts` + backtest engine.
- `src/risk/manager.ts`: gates refactored into `private gates(...)`; `evaluateBuy` (open-position gate on) and `evaluateDca` (gate skipped) share the chain — cooldown/trade-cap/volatility/exposure still apply.
- `src/strategy/hybrid.ts`: on holding ticks, if price ≤ avg entry × (1−belowPct) and the next unconsumed level clears risk, emit BUY with `dca:true` + `sizePct=buyPct`; level consumed only on risk approval.
- `orders.kind` column (`entry|dca|exit`) with idempotent ALTER TABLE migration for existing DBs; executor takes a `kind` param; `portfolio.applyTrade` already merges + recomputes avg entry.
- Tests `tests/dca.test.ts` (10: ladder order/caps, evaluateDca gate skip, strategy emit/consume/blocked/merge, migration); suite 54/54, typecheck + build clean.

### P1-5 Trigger engine (rule DSL) — DONE (2026-08-25)
- `src/triggers/engine.ts`: declarative `TRIGGERS` rules (id/symbol/when/then); conditions rsi/price/sentiment below/above; actions notify (Telegram) + halt; edge-triggered (fires once on false→true, re-arms on crossing back).
- Config: `TRIGGERS` JSON env validated by zod (dup id / unknown symbol rejected against SYMBOLS); `config.triggers`.
- `src/risk/manager.ts`: public `haltTrading(reason)` sets the in-memory halt state (same gate used by daily-loss halt).
- `src/index.ts`: engine evaluated per symbol in `tick` after poll/refresh, before strategy; events → risk_events(kind=trigger) + notify/halt handling.
- Tests `tests/triggers.test.ts` (11: edge firing, re-arm, condition types, symbol filter, null inputs, actions/messages, config validation, halt wiring); suite 65/65, typecheck + build clean.

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
