# Project Map — nobitex-sentiment-bot
Updated: 2026-08-24

## Shape
```
/workspace
├── src/                    # TypeScript source (ESM, NodeNext)
│   ├── alerts/             # Telegram notifier + daily HTML report
│   ├── backtest/           # History replay engine + CLI (P1-1)
│   ├── export/             # CSV export CLI (trades / closed positions) (P1-2)
│   ├── exchange/           # Nobitex REST client (apiv2.nobitex.ir)
│   ├── execution/          # Order placement: live vs simulated fills
│   ├── market/             # Per-symbol price series, poll + trade seeding
│   ├── portfolio/          # Holdings, equity, PnL, position lifecycle
│   ├── report/             # Performance analytics from audit DB (P1-2)
│   ├── risk/               # Limit gates, volatility sizing, daily-loss halt, trailing stops
│   ├── sentiment/          # HTTP webhook + JSONL feed + aggregation engine
│   ├── strategy/           # Hybrid RSI + sentiment entry/exit rules + DCA ladder (P1-4)
│   ├── index.ts            # Orchestrator: poll loop, execution, scheduling
│   ├── config.ts           # Zod-validated env config
│   ├── db.ts               # SQLite audit store (better-sqlite3)
│   ├── indicators.ts       # Wilder RSI + log-return volatility
│   ├── logger.ts           # Pino factory
│   └── types.ts            # Shared domain types
├── scripts/                # curl helper to feed sentiment webhook
├── tests/                  # node:test suites (in-memory DB)
├── dist/                   # tsc build output (excluded)
├── .env.example            # Full config template (copy to .env)
├── package.json            # ESM scripts + deps
├── tsconfig.json           # strict, NodeNext, outDir dist
└── README.md               # Architecture + quick start
```

## Commands
build: `tsc -p tsconfig.json` → dist/ | test: `tsx --test tests/*.test.ts` | run: `tsx src/index.ts` (dev: `tsx watch src/index.ts`; serve: `node dist/index.js`) | lint: none (typecheck: `tsc --noEmit -p tsconfig.json`)

## Inventory
src/index.ts — composition root; wiring, poll loop, signal logging, signal handlers
src/config.ts — zod env schema → typed BotConfig; SYMBOLS parsing and validation
src/types.ts — shared domain types (SymbolPair, SignalDecision, Position, OrderRecord...)
src/db.ts — AuditDb: 9 tables, indexes, all insert/query methods, migrations on open
src/logger.ts — pino logger, pino-pretty transport at debug/trace
src/indicators.ts — RSI (Wilder smoothing), volatility (60-bar log returns)
src/exchange/nobitex.ts — REST client: stats, trades, wallets, addOrder/status/cancel; per-path public throttle
src/market/priceFeed.ts — in-memory PricePoint series, seed from recent trades, poll stats
src/sentiment/engine.ts — confidence × time-decay weighted sentiment score
src/sentiment/server.ts — HTTP server: /healthz, POST /api/v1/sentiment, JSONL file poller
src/strategy/hybrid.ts — evaluate(): warmup gate, exits, then sentiment+RSI entry with risk veto
src/strategy/dca.ts — DcaLadder: sorted {belowPct,buyPct} levels consumed in order per position; consumed only after risk approval; maxOrders cap
src/risk/manager.ts — evaluateBuy gate chain, volatility sizing, stop-loss/take-profit, trailing stops, evaluateDca (skips open-position gate), halt state
src/portfolio/manager.ts — dry-run virtual holdings vs live wallets; applyTrade PnL accounting
src/execution/executor.ts — fills at best bid/ask, dry-run simulation or live addOrder, fee calc
src/alerts/telegram.ts — sendMessage with HTML, logs every alert to DB
src/alerts/report.ts — DailyReporter: snapshot, HTML report, prev-day equity meta
src/backtest/data.ts — loadHistory: paged /market/udf/history fetch (exchange keeps ~500 bars) + loadSentimentFile
src/backtest/engine.ts — runBacktest: replays real strategy/risk/portfolio over bars on an injectable clock
src/backtest/run.ts — CLI: --symbol/--days/--resolution/--sentiment/--sentiment-file/--json/--verbose
src/report/metrics.ts — computeMetrics: win rate, profit factor, drawdown, Sharpe, exposure from audit DB
src/export/trades.ts — CSV export CLI: --kind trades|positions, --from/--to (UTC dates); EPIPE-safe stdout
scripts/feed_sentiment.sh — sample curl POST of sentiment batch to webhook
tests/indicators.test.ts — RSI/volatility edge cases
tests/backtest.test.ts — backtest replay (win/loss/flat) + UDF mapping
tests/metrics.test.ts — analytics over synthetic positions/snapshots/trades
tests/risk.test.ts — risk gate order and halt behavior
tests/dca.test.ts — DCA ladder order/caps, evaluateDca gate skip, strategy emit/consume/merge, orders.kind migration
tests/strategy.test.ts — hybrid strategy buy/hold/sell paths
tests/sentiment.test.ts — sentiment aggregation behavior
.env.example — documented env contract; copy to .env
tsconfig.json — strict ES2022 NodeNext build config

## Key symbols
src/index.ts:35 main — composition root; instantiates all services from config
src/index.ts:136 tick — core loop: priceFeed.poll → portfolio.refresh → strategy.evaluate → executeDecision
src/index.ts:92 executeDecision — maps BUY/SELL decision to executor + trade alert; records signals when trading disabled
src/index.ts:16 scheduleDaily — computes delay to HH:MM and starts daily reporter interval
src/config.ts:5 envSchema — zod schema; every runtime knob validated with defaults
src/config.ts:97 parseSymbols — parses "btc/rls" pairs, dedupes, requires one pair in quote currency
src/db.ts:35 migrate — creates signals/orders/trades/positions/risk_events/sentiment_events/portfolio_snapshots/alerts/meta
src/db.ts:152 insertSignal — audit row for every decision (incl. HOLD/blocked)
src/db.ts:172 insertOrder — orders row incl. kind (entry|dca|exit, default 'entry'); ALTER TABLE migration adds kind to legacy DBs
src/db.ts:257 closePosition — closes position, records realized PnL and exit reason
src/exchange/nobitex.ts:35 throttle — 3s min gap per public endpoint path
src/exchange/nobitex.ts:88 marketStats — price poll source; status must be "ok"
src/market/priceFeed.ts:21 seed — backfills series from /v2/trades history
src/market/priceFeed.ts:45 append — dedupes by ts, trims to seriesMaxPoints
src/sentiment/engine.ts:41 ingest — clamps sentiment/confidence to ±1, persists, prunes
src/sentiment/engine.ts:73 snapshot — weighted score = Σ(confidence·decay·value)/Σ(confidence·decay)
src/sentiment/server.ts:56 handle — Bearer-auth POST /api/v1/sentiment, accepts single or array
src/sentiment/server.ts:104 pollFeed — re-reads JSONL only when mtime changes
src/strategy/hybrid.ts:41 evaluate — decision tree: warmup → SL/TP → sentiment-exit → overbought → entry
src/risk/manager.ts:83 evaluateBuy — sequential gates: halted, open position, cooldown, volatility, min value, exposure, position size, daily loss, trade count, RSI
src/risk/manager.ts:44 sizeByVolatility — scales size by benchmark/volatility ratio, capped
src/risk/manager.ts:105 evaluateBuy — delegates to gates(..., skipOpenPosition=false)
src/risk/manager.ts:109 evaluateDca — delegates to gates(..., skipOpenPosition=true); used by DCA fills
src/risk/manager.ts:113 gates — sequential gates: halted, cooldown, volatility, min value, exposure, position size, daily loss, trade count, RSI (open-position gate optional)
src/risk/manager.ts:189 checkStopLoss — stop at entryPrice × (1 − stopLossPct/100)
src/risk/manager.ts:209 checkTrailingStops — per-position peak + armed flags; stop arms at ACTIVATE% above entry, TP arms too; armed TP supersedes fixed TP in strategy; state keyed by positionId, resets on close/change
src/portfolio/manager.ts:134 applyTrade — updates holdings, merges/re-opens positions, stores daily realized PnL meta
src/execution/executor.ts:67 execute — best bid/ask fill price, live addOrder w/ clientOrderId, fee = total × feePct
src/alerts/report.ts:40 generateReport — writes portfolio_snapshots and prev_day_equity meta
src/backtest/data.ts:11 loadHistory — pages /market/udf/history; retention ~500 bars (60m≈21d, 240m≈83d); rls→irt via toUdfSymbol
src/backtest/engine.ts:31 runBacktest — builds strategy/risk/portfolio with `now` clock; fills at bar close; :memory: db; day-roll sets prev_day_equity
src/backtest/run.ts:52 main — arg parsing; requires --sentiment or --sentiment-file; warns on retention-short spans
src/exchange/nobitex.ts:113 udfHistory — UDF OHLC {s,t,o,h,l,c,v}, public-path throttled
src/market/priceFeed.ts:5 toUdfSymbol — rls→irt UDF symbol mapping (shared by seed + backtest)
src/report/metrics.ts:55 computeMetrics — range-filtered (default 30d) performance metrics from closed positions + snapshots
src/export/trades.ts:62 main — CSV export to stdout; handles EPIPE for `| head`; --kind positions uses closedPositionsBetween
src/db.ts:255 closedPositionsBetween — closed positions by close_ts range (for metrics/export)
src/db.ts:290 snapshotsBetween — equity/positions_value series by ts range (drawdown/Sharpe/exposure)

## Data flow
1. Sentiment: scripts/feed_sentiment.sh (or external pipeline) → POST :3001/api/v1/sentiment → src/sentiment/server.ts:handle → engine.ingest → sentiment_events table
2. Prices: src/market/priceFeed.ts poll() → GET /market/stats → in-memory series → indicators.ts (RSI, volatility)
3. Decision: strategy/hybrid.ts evaluate() → risk/manager.ts evaluateBuy() veto → signals table (every decision logged)
4. Execution: executor.ts execute() → orders + trades tables → portfolio.applyTrade() → positions table + meta `day:YYYY-MM-DD:realized_pnl`
5. Notify: TelegramNotifier.send() → alerts table → api.telegram.org sendMessage
6. Report: DailyReporter.generateReport() → portfolio_snapshots table + meta prev_day_equity (read back by RiskManager)

## Conventions & gotchas
- ESM only (`"type": "module"`); TS source imports must use `.js` extensions (NodeNext resolution)
- All config via env vars, validated by zod in src/config.ts:5; .env.example is the contract; never commit .env
- Defaults are safety-first: DRY_RUN=true (simulated fills), TRADING_ENABLED=false (monitor-only); live trading requires flipping both
- Symbol keys are lowercase "btc/rls"; exchange market string "BTC-RLS"; UDF trade-feed symbol maps rls→irt (priceFeed.ts:40)
- Timestamps are ISO strings; "day" boundaries use UTC day keys via toISOString().slice(0,10) — daily counters roll at 00:00 UTC
- SQLite opened in WAL mode; `:memory:` supported for tests; DB dir auto-created; better-sqlite3 is a native module (rebuild after Node upgrades)
- SentimentEngine keeps an in-memory event buffer capped at 5000, pruned only on ingest; window expiry is lazy
- Nobitex auth header is `Authorization: Token <key>`; public endpoints self-throttled 3s per path; 429 and bad JSON raise NobitexError
- Risk halt state is in-memory only — resets on restart; RSI=100 when avg loss is zero (all gains)
- Trade signals are recorded even when trading is disabled (audit); HOLD/blocked decisions also insert signal rows
- Tests build the full object graph manually with in-memory DB and dry-run portfolio; strategy tests push synthetic close series with backdated timestamps
- No lint configured; `npm run typecheck` is the only static check; tsconfig excludes tests from build
- RiskManager/PortfolioManager/SentimentEngine accept an optional `now: () => number` clock (default Date.now); timestamps, day keys, cooldown and halt state all use it — backtester passes a virtual clock that advances per bar
- Backtester fills at bar close (no spread), uses `:memory:` db (never touches audit.db), needs an explicit sentiment source (constant or file)
- DailyReporter includes a "Performance (last 30d)" section from report/metrics.ts; metrics need `portfolio_snapshots` for drawdown/Sharpe/exposure, closed positions for win-rate/profit-factor
- CSV export formats large rial values as integers (FP-noise epsilon 1e-4); amounts keep up to 8 decimals
- Trailing stop/TP default OFF (0); trailing state is in-memory (Map keyed by positionId), resets on restart — same caveat as risk halt state
- Strategy exit order: fixed stop-loss (floor) → trailing stop/TP → fixed take-profit (skipped while trailing TP armed); keep TRAILING_TP_ACTIVATE_PCT <= TAKE_PROFIT_PCT for trailing TP to take effect
- DCA: levels sorted by belowPct; consumed one per tick in order (gap-downs don't skip levels); level consumed only after risk approval — blocked levels stay pending; stop-loss fires before a deep DCA level unless STOP_LOSS_PCT exceeds the level depth
- DCA fills pass normal risk gates minus the open-position gate; cooldown/trade-cap still apply, so consecutive fills are throttled by COOLDOWN_MINUTES
