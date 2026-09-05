# Project Map — nobitex-sentiment-bot
Updated: 2026-09-05
## Shape
```
/workspace
├── src/                    # TypeScript source (ESM, NodeNext)
│   ├── alerts/             # Telegram notifier + daily HTML report
│   ├── backtest/           # History replay engine + CLI; MM sim gateway (P3-4)
│   ├── export/             # CSV export CLI (trades / closed positions) (P1-2)
│   ├── exchange/           # Nobitex REST client + Binance arb client (P3-4)
│   ├── execution/          # Order placement: live/simulated fills; OrderGateway for resting quotes
│   ├── market/             # Per-symbol price series, poll + trade seeding
│   ├── portfolio/          # Holdings, equity, PnL, position lifecycle
│   ├── report/             # Performance analytics from audit DB (P1-2)
│   ├── risk/               # Limit gates, volatility sizing, daily-loss halt, trailing stops
│   ├── sentiment/          # HTTP webhook + JSONL feed + aggregation engine
│   ├── signals/            # Unified SignalIntent bus: broker, FIFO trade intents (P2-3)
│   ├── strategy/           # Hybrid + DSL + AI advisor + DCA + market making + arbitrage (P1-4..P3-4)
│   ├── config/             # Strategy pool parsing + per-symbol build (P2-1)
│   ├── triggers/           # Declarative rule DSL: condition -> notify/halt (P1-5, P3-5 indicator conditions)
│   ├── reconcile.ts        # DB-vs-exchange holdings reconciliation CLI (P3-5)
│   ├── index.ts            # Orchestrator: poll loop, execution, scheduling, boot() recovery (P3-5)
│   ├── config.ts           # Zod-validated env config
│   ├── db.ts               # SQLite audit store (better-sqlite3); meta JSON helpers (P3-5)
│   ├── indicators.ts       # Wilder RSI + log-return volatility + SMA/EMA + MACD/Bollinger/stoch/ATR-proxy rich set (P2-1, P3-5)
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
src/db.ts — AuditDb: 11 tables (incl. margin_positions), indexes, insert/query methods, migrations on open; orders.kind also mm_bid/mm_ask/mm_exit/arb; getOrder mapping fix + mapOrder/openOrders(symbol?); getMetaJSON/setMetaJSON (versioned JSON blobs for persisted risk/MM state)
src/logger.ts — pino logger, pino-pretty transport at debug/trace
src/indicators.ts — RSI (Wilder smoothing), volatility (60-bar log returns), SMA/EMA (null on insufficient data); plus P3-5 rich set: emaSeries, calculateMACD (12/26/9), calculateBollinger (20/2), calculateStoch (14/3, close-based), calculateCloseRangePct (ATR proxy), computeRichIndicators -> {macdHistPct, atrPct, stochK, stochD, bollinger{upper,middle,lower}}
src/config/pools.ts — parseStrategyPools (symbol -> "hybrid"|"ai"|"mm"|"arb"|DSL) + buildStrategyPool -> Map<symbol, StrategyLike>; StrategyLike.evaluate promise-capable; shared hybrid/ai instances; StrategyPoolDeps.ai/.mm/.arb/.arbClient/.nobitexClient/.tradingActive/.dryRun/.feePct/.allKeys; optional MM/ARB fall back to hybrid
src/exchange/nobitex.ts — REST client: stats, trades, wallets, addOrder/status/cancel (cancelOrder returns updated order incl. matchedAmount), margin endpoints; per-path public throttle
src/exchange/arb.ts — ArbExchangeClient interface + BinanceArbClient (fetch bookTicker; signed marketBuy/marketSell/getBalance require USER_ARB_* creds; 3s in-flight window)
src/market/priceFeed.ts — in-memory PricePoint series, seed from recent trades, poll stats; setBar() feeds the backtest gateway
src/sentiment/engine.ts — confidence × time-decay weighted sentiment score
src/sentiment/server.ts — HTTP server: /healthz, POST /api/v1/sentiment, POST /api/v1/tradingview (Bearer auth); validates payloads then submit()s SignalIntents to the broker; JSONL file poller
src/signals/broker.ts — SignalBroker: sentiment intents -> registered subscriber (returns result), trade intents -> bounded per-symbol FIFO drained via shiftTrade; sources sentiment-webhook|sentiment-feed|tradingview|manual|scheduled
src/strategy/hybrid.ts — HybridStrategy evaluate(): warmup gate, exits, then sentiment+RSI entry with risk veto; SHORT (RSI>=overbought + sentiment<=-entryThreshold) and COVER (sentiment turn / RSI<=entry ceiling / margin stop/tp/trailing) when margin enabled
src/strategy/dsl.ts — DslStrategy: zod-validated entry/exit condition trees (rsi/volatility/sentiment/price vs SMA|EMA, and/or/not); same risk gates + DCA; DSL entries skip hybrid RSI ceiling
src/strategy/ai.ts — AiAdvisorStrategy: async LLM-driven BUY/SELL/HOLD via HttpLlmClient (OpenAI-compatible /chat/completions); snapshot = bars+indicators+sentiment+position+riskLimits; P3-5 adds macdHistPct/atrPct/stochK/stochD/bollinger{upper,middle,lower} to the snapshot; minIntervalMs throttle; warmup; errors→HOLD; BUY passes risk.skipRsiGate, SELL needs open position; parseAdvice extracts+clamps the JSON reply
src/strategy/dca.ts — DcaLadder: sorted {belowPct,buyPct} levels consumed in order per position; consumed only after risk approval; maxOrders cap
src/strategy/mm.ts — MarketMakingStrategy (StrategyLike, manage? per tick): bid-only when no inventory then both sides, inventory-aware skew capped by MM_MAX_INVENTORY_VALUE, stale-quote cancel+requote, fill cooldown, stop-loss market close; P3-5 persist(): meta mm.state.<pairKey> (costBasis/lastFillAt) + restore() re-adopts inventory from open positions and resting quote ids/timestamps from db.openOrders (mm_bid/mm_ask)
src/strategy/arb.ts — ArbitrageStrategy (manage? per tick): bidirectional fee-adjusted round trips vs arb exchange, equity sizing, cooldown; dry-run simulates legs locally (never touches 2nd exchange), live checks sell-side balance, remote errors swallowed by caller
src/triggers/engine.ts — TriggerEngine: edge-triggered rules (rsi/price/sentiment/volatility/atr_pct/stoch_k/stoch_d/macd_hist_pct below/above) -> notify/halt; per-symbol evaluation before strategy; currentValue/conditionMet per condition type
src/risk/manager.ts — evaluateBuy gate chain, volatility sizing, stop-loss/take-profit, trailing stops, evaluateDca (skips open-position gate), halt state; evaluateBuy accepts {skipRsiGate} for DSL entries; evaluateShort + margin stop/tp/trailing (inverted); hasAnyOpenPosition blocks both directions; P3-5 persist()/restore() via meta risk.state_v1 (halt reason/ts, cooldowns, trailing ratchets, margin trailing)
src/portfolio/manager.ts — dry-run virtual holdings vs live wallets; applyTrade PnL accounting; margin short pnl (unrealized in equity, realized credited to quote), applyMarginOpen/applyMarginClose
src/execution/executor.ts — fills at best bid/ask, dry-run simulation or live addOrder, fee calc; execute(mode: spot|margin) + openShort/coverShort; implements OrderGateway (placeLimit/cancel/poll for resting limit orders; dry-run crosses-price fill; live poll books fills only at a terminal state per the official orders/status contract, partial-Active keeps residual tracked until Done/Canceled, clientOrderId retry fallback, cancel returns false when it raced a fill/request failed so the matched portion is booked once by poll; applyLimitFill -> AuditDb + applyTrade + recordTrade); P3-5 recoverLiveOrders(): re-polls every DB order still `new` on boot, books down-time fills once, marks canceled/failed, skips dry-run/live mode-mismatched rows -> RecoveryReport; exports pairFromKey
src/execution/gateway.ts — OrderGateway interface: getBestPrices/getLatestPrice/getBalance/placeLimit/cancel/poll/market
src/reconcile.ts — deriveSpotExpectation (open positions − amount resting in open sells per base) + reconcile() vs PortfolioManager.getHoldings() + formatReport + main CLI; exit 1 on drift; skips DRY_RUN bots; never trades
src/alerts/telegram.ts — sendMessage with HTML, logs every alert to DB
src/alerts/report.ts — DailyReporter: snapshot, HTML report, prev-day equity meta
src/backtest/data.ts — loadHistory: paged /market/udf/history fetch (exchange keeps ~500 bars) + loadSentimentFile
src/backtest/engine.ts — runBacktest: replays real strategy/risk/portfolio over bars on an injectable clock; async (await strategy.evaluate), ai:null (no LLM); calls strategy.manage?.(pair) per tick
src/backtest/gateway.ts — backtest OrderGateway over in-engine bars: MM limit fills at limit price intra-bar, market exits; feeds DB via portfolio+risk
src/backtest/run.ts — CLI: --symbol/--days/--resolution/--sentiment/--sentiment-file/--json/--verbose
src/report/metrics.ts — computeMetrics: win rate, profit factor, drawdown, Sharpe, exposure from audit DB
src/export/trades.ts — CSV export CLI: --kind trades|positions, --from/--to (UTC dates); EPIPE-safe stdout
scripts/feed_sentiment.sh — sample curl POST of sentiment batch to webhook
tests/indicators.test.ts — RSI/volatility edge cases + MACD on exponential trend, warmup nulls, Bollinger SMA±bands, stoch bounds/saturation, flat-vs-choppy ATR proxy
tests/backtest.test.ts — backtest replay (win/loss/flat) + UDF mapping
tests/metrics.test.ts — analytics over synthetic positions/snapshots/trades
tests/recovery.test.ts — P3-5: trigger halt restored same day, daily-loss halt cleared next day, trailing ratchet survives restart and fires on pullback, filled-while-down booked exactly once (avg price), canceled-while-down marked, mode-mismatch never polled, MM adopts bid/ask ids + polls on first manage
tests/risk.test.ts — risk gate order and halt behavior
tests/dca.test.ts — DCA ladder order/caps, evaluateDca gate skip, strategy emit/consume/merge, orders.kind migration
tests/triggers.test.ts — trigger edge firing/re-arm, condition types, config validation, halt wiring
tests/signals.test.ts — SignalBroker: sentiment routing+result, rejections, trade FIFO/queue/drain, no-subscriber acceptance
tests/dsl.test.ts — DSL node semantics, warmup, entry/exit, trend entry, pool parse/validation/assignment, config rejection
tests/mm.test.ts — MM config parse (default off), executor-gateway limit resting/fill/cancel + trade record, real-gateway strategy: bid-only->both-sides, ask fill closes position, stop-loss market close, cooldown, stale-quote requote, max-inventory bid cap, disabled/monitor-only/halt
tests/orderpoll.test.ts — live resting-order lifecycle with stubbed NobitexClient: full-fill booking, averagePrice fallback to limit price, partial-Active deferral + terminal booking, cancel-race books matched once, immediate-fill rests (not failed), clean cancel, clientOrderId fallback on id miss, MM partial-at-cancel end-to-end
tests/arb.test.ts — arb config parse + live-credential validation, forward + reverse direction dry-run round trips (never touches 2nd exchange), min-profit/cooldown, live sell-side inventory gate, monitor-only, halt, BinanceArbClient parse + cred requirement
tests/bots.test.ts — loadConfigs: single default, N merged configs, inherited defaults, malformed BOTS_JSON rejections, port-0/BOT_NAME
tests/tradingview.test.ts — TradingView alert parse (action/ticker/hold/reject), broker enqueue, HTTP endpoint enqueue+persist, auth/disabled/symbol errors, sentiment-through-broker
tests/strategy.test.ts — hybrid strategy buy/hold/sell paths
tests/sentiment.test.ts — sentiment aggregation behavior
.env.example — documented env contract; copy to .env
tsconfig.json — strict ES2022 NodeNext build config

## Key symbols
src/index.ts:35 main — composition root for N bots; starts one bot per config from loadConfigs(); SIGINT/SIGTERM stop all
src/index.ts:38 startBot — full per-bot object graph + own tick/executeDecision/processTradingViewIntent; returns BotRuntime{name,stop}; webhook conditional on port>0
src/index.ts:136 tick — core loop: priceFeed.poll → portfolio.refresh → strategy.evaluate → executeDecision → strategy.manage?.(pair) (MM/arb per-tick hook)
src/index.ts:92 executeDecision — maps BUY/SELL decision to executor + trade alert; records signals when trading disabled
src/index.ts:16 scheduleDaily — computes delay to HH:MM and starts daily reporter interval
src/config.ts:5 envSchema — zod schema; every runtime knob validated with defaults
src/config.ts:97 parseSymbols — parses "btc/rls" pairs, dedupes, requires one pair in quote currency
src/config.ts:277 loadConfigs — BOTS_JSON array of env-override objects -> BotConfig[] (single config when unset); each entry merged over base env
src/config.ts:7 boolEnv — boolean env preprocess so string "false" parses false (z.coerce.boolean mis-parsed it as true)
src/strategy/mm.ts:161 manage — per-tick resting-quote loop: pollOrders (fills/age-cancel) -> cooldown -> stop-loss -> inventory-skewed bid/ask requote
src/strategy/arb.ts:94 manage — per-tick cross-exchange scan: fee-adjusted both-direction round trips, equity sizing, dry-run/local vs live/remote legs
src/execution/executor.ts placeLimit/cancel/poll — resting limit lifecycle via Nobitex addOrder/orderStatus; dry-run crossed-price fill; live poll books at terminal Done/Canceled only (deferral keeps partial residuals tracked), clientOrderId retry, cancel returns false on partial-race/request-failure; applyLimitFill routes fills to DB+portfolio+risk
src/db.ts:35 migrate — creates signals/orders/trades/positions/risk_events/sentiment_events/tradingview_signals/portfolio_snapshots/alerts/meta
src/db.ts:152 insertSignal — audit row for every decision (incl. HOLD/blocked)
src/db.ts:172 insertOrder — orders row incl. kind (entry|dca|exit|mm_bid|mm_ask|mm_exit|arb, default 'entry'); ALTER TABLE migration adds kind to legacy DBs
src/db.ts:xxx getMetaJSON/setMetaJSON — read/write arbitrary JSON under the meta table (used for risk.state_v1 and mm.state.<pairKey>); setMetaJSON is best-effort (throws are swallowed by callers)
src/risk/manager.ts:xxx persist — writes PersistedRiskState (halt reason/ts, per-pair cooldowns, trailing stop/TP ratchets, margin trailing state) to meta risk.state_v1 on every mutation
src/risk/manager.ts:xxx restore — rehydrates state on boot; daily-loss halts clear when the restart lands on a new UTC day (halt-cleared), trigger halts restore as-is (halt-restored)
src/execution/executor.ts:xxx recoverLiveOrders — boot-time sweep of every order still `new` in the DB (filters dryRun/live to current mode); poll each exactly once, book terminal fills, mark canceled/failed -> RecoveryReport
src/strategy/mm.ts:xxx persist/restore — per-pair meta mm.state.<pairKey> (costBasis/lastFillAt); restore() re-adopts inventory from open positions + resting quote ids/timestamps from db.openOrders (mm_bid/mm_ask)
src/reconcile.ts:xxx reconcile — spot expectation vs exchange wallet; returns report rows; main() exits 1 on drift beyond dust tolerance
src/indicators.ts:xxx computeRichIndicators — needs ~45 closes (26 EMA + 9 signal + margin); returns null fields until warmup
src/index.ts:xxx boot — async pre-tick: executor.recoverLiveOrders() then per-strategy restore?.() (StrategyLike.restore is optional); runs before the first tick of the day
src/db.ts:257 closePosition — closes position, records realized PnL and exit reason
src/exchange/nobitex.ts:35 throttle — 3s min gap per public endpoint path
src/exchange/nobitex.ts:88 marketStats — price poll source; status must be "ok"
src/market/priceFeed.ts:21 seed — backfills series from /v2/trades history
src/market/priceFeed.ts:45 append — dedupes by ts, trims to seriesMaxPoints
src/sentiment/engine.ts:41 ingest — clamps sentiment/confidence to ±1, persists, prunes
src/sentiment/engine.ts:73 snapshot — weighted score = Σ(confidence·decay·value)/Σ(confidence·decay)
src/sentiment/server.ts:56 handle — Bearer-auth POST /api/v1/sentiment, accepts single or array; submits sentiment intents to broker
src/sentiment/server.ts:104 pollFeed — re-reads JSONL only when mtime changes; submits sentiment intents to broker
src/sentiment/server.ts:147 handleTradingView — Bearer-auth POST /api/v1/tradingview; 404 when TRADINGVIEW_ENABLED off; parse -> broker.submit(kind:trade) + persist
src/sentiment/server.ts:87 parseTradingViewAlert — maps action/strategy.order.action + symbol/ticker; returns {intent: TradeIntent, error}
src/signals/broker.ts:30 onSentiment — register the sentiment subscriber (wired to SentimentEngine.ingest in index.ts)
src/signals/broker.ts:42 submit — routes by kind: sentiment -> subscriber, trade -> per-symbol bounded FIFO; returns SubmitResult
src/signals/broker.ts:87 shiftTrade — pop oldest trade intent for a symbol (drained one per tick)
src/index.ts:173 processTradingViewIntent — drains one intent/symbol/tick: BUY -> risk.evaluateBuy(skipRsiGate), SELL -> needs open position; routes via executeDecision
src/index.ts:210 signals.shiftTrade — called per pair after the strategy decision in tick
src/strategy/hybrid.ts:41 evaluate — decision tree: warmup → SL/TP → sentiment-exit → overbought → entry
src/risk/manager.ts:83 evaluateBuy — sequential gates: halted, open position, cooldown, volatility, min value, exposure, position size, daily loss, trade count, RSI
src/risk/manager.ts:44 sizeByVolatility — scales size by benchmark/volatility ratio, capped
src/risk/manager.ts:105 evaluateBuy — delegates to gates(..., skipOpenPosition=false)
src/risk/manager.ts:109 evaluateDca — delegates to gates(..., skipOpenPosition=true); used by DCA fills
src/risk/manager.ts:113 gates — sequential gates: halted, cooldown, volatility, min value, exposure, position size, daily loss, trade count, RSI (open-position gate optional)
src/risk/manager.ts:263 haltTrading — public halt; sets tradingHalted + logs halt-trigger event
src/triggers/engine.ts:99 evaluate — per-symbol rule scan; fires only on false->true edge (prevTruth map keyed by rule id); reset() clears edge state
src/config.ts:176 parseTriggers — zod-validated TRIGGERS JSON; rejects dup ids and symbols not in SYMBOLS
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
1. Intents: POST :3001/api/v1/sentiment | /api/v1/tradingview | JSONL feed → src/sentiment/server.ts validates → SignalBroker.submit → sentiment intents → sentimentEngine.ingest → sentiment_events; trade intents → bounded per-symbol FIFO
1b. TradingView drain: tick → signals.shiftTrade(pair.key) → processTradingViewIntent → risk veto → executeDecision; alerts in tradingview_signals table
2. Prices: src/market/priceFeed.ts poll() → GET /market/stats → in-memory series → indicators.ts (RSI, volatility)
3. Triggers: src/triggers/engine.ts evaluate() per symbol in tick (rsi/price/sentiment) → risk_events(kind=trigger) + notify (alerts table) / halt (risk manager)
4. Decision: strategy resolved per symbol via config/pools.ts buildStrategyPool (hybrid default, DSL override) → strategy/*.ts evaluate() → risk/manager.ts evaluateBuy/evaluateDca veto → signals table (every decision logged)
5. Execution: executor.ts execute() → orders + trades tables → portfolio.applyTrade() → positions table + meta `day:YYYY-MM-DD:realized_pnl`
6. Notify: TelegramNotifier.send() → alerts table → api.telegram.org sendMessage
7. Report: DailyReporter.generateReport() → portfolio_snapshots table + meta prev_day_equity (read back by RiskManager)

## Conventions & gotchas
- ESM only (`"type": "module"`); TS source imports must use `.js` extensions (NodeNext resolution)
- All config via env vars, validated by zod in src/config.ts:5; .env.example is the contract; never commit .env
- Defaults are safety-first: DRY_RUN=true (simulated fills), TRADING_ENABLED=false (monitor-only); live trading requires flipping both
- Symbol keys are lowercase "btc/rls"; exchange market string "BTC-RLS"; UDF trade-feed symbol maps rls→irt (priceFeed.ts:40)
- Timestamps are ISO strings; "day" boundaries use UTC day keys via toISOString().slice(0,10) — daily counters roll at 00:00 UTC
- SQLite opened in WAL mode; `:memory:` supported for tests; DB dir auto-created; better-sqlite3 is a native module (rebuild after Node upgrades)
- SentimentEngine keeps an in-memory event buffer capped at 5000, pruned only on ingest; window expiry is lazy
- Nobitex auth header is `Authorization: Token <key>`; public endpoints self-throttled 3s per path; 429 and bad JSON raise NobitexError
- Risk halt state is PERSISTED since P3-5 — risk/manager.ts writes halt reason/ts, per-pair cooldowns, and trailing stop/TP ratchets to meta `risk.state_v1` on every mutation and rehydrates them in `restore()` at boot; a persisted daily-loss halt clears only when the restart lands on a new UTC day (halt-cleared), a trigger halt restores as-is (halt-restored). This supersedes the old "resets on restart" caveat. RSI=100 when avg loss is zero (all gains)
- Trade signals are recorded even when trading is disabled (audit); HOLD/blocked decisions also insert signal rows
- Tests build the full object graph manually with in-memory DB and dry-run portfolio; strategy tests push synthetic close series with backdated timestamps
- No lint configured; `npm run typecheck` is the only static check; tsconfig excludes tests from build
- RiskManager/PortfolioManager/SentimentEngine accept an optional `now: () => number` clock (default Date.now); timestamps, day keys, cooldown and halt state all use it — backtester passes a virtual clock that advances per bar
- Backtester fills at bar close (no spread), uses `:memory:` db (never touches audit.db), needs an explicit sentiment source (constant or file)
- DailyReporter includes a "Performance (last 30d)" section from report/metrics.ts; metrics need `portfolio_snapshots` for drawdown/Sharpe/exposure, closed positions for win-rate/profit-factor
- CSV export formats large rial values as integers (FP-noise epsilon 1e-4); amounts keep up to 8 decimals
- Trailing stop/TP default OFF (0); trailing ratchet state (peak + armed, keyed by positionId) is persisted to meta risk.state_v1 and restored at boot, so a restart no longer forgets a trailing peak
- P3-5 boot ordering (startBot -> boot()): executor.recoverLiveOrders() polls every DB order still `new` exactly once (books fills that happened while down, marks canceled/failed, skips rows whose dryRun/live flag mismatches the current mode), THEN each strategy's optional restore?.() rehydrates (MM re-adopts inventory/costBasis from meta mm.state.<pairKey> + resting mm_bid/mm_ask ids from openOrders) — all before the first tick of the day; persist()/setMetaJSON writes are wrapped so a meta failure never takes a tick down
- P3-5 rich indicators: MACD (12/26/9) histogram as % of price (macdHistPct), Bollinger 20/2 bands, close-range ATR proxy (atrPct, % of prior close), close-based stochastic %K/%D (14/3); deterministic on the stored close-only series (true OHLC ATR/stoch would need high/low data the bot doesn't retain), warmup ~45 closes, gaps return null; reused by DSL advanced nodes (macd_hist_pct_*, atr_pct_*, stoch_*, boll_pct_*), trigger conditions (incl. volatility_above/below) and the AI snapshot — rich indicators are computed per tick ONLY when a trigger needs them (richIndicatorTriggerTypes) to avoid the cost otherwise
- Strategy exit order: fixed stop-loss (floor) → trailing stop/TP → fixed take-profit (skipped while trailing TP armed); keep TRAILING_TP_ACTIVATE_PCT <= TAKE_PROFIT_PCT for trailing TP to take effect
- DslStrategy exit order (holding): fixed stop-loss → trailing → take-profit → DSL exit tree → DCA; DSL entry rule gates buys but fixed stop/trailing/take-profit always apply; warmup = max(rsiPeriod+5, maxMaPeriod+1, warmupSamples)
- DSL entries skip the hybrid RSI-entry ceiling (RSI < RSI_ENTRY_UPPER) because the DSL's own entry tree encodes timing; volatility/exposure/cooldown/trade-cap gates still apply — RSI ceiling only guards the default hybrid entry
- STRATEGY_POOLS is a JSON object symbol -> "hybrid"|"ai"|"mm"|"arb"|DSL; symbols not listed get the shared hybrid instance; pool symbols are validated against SYMBOLS at startup; backtester replays the pool assignment for the symbol under test (MM supported, arb excluded)
- DCA: levels sorted by belowPct; consumed one per tick in order (gap-downs don't skip levels); level consumed only after risk approval — blocked levels stay pending; stop-loss fires before a deep DCA level unless STOP_LOSS_PCT exceeds the level depth
- DCA fills pass normal risk gates minus the open-position gate; cooldown/trade-cap still apply, so consecutive fills are throttled by COOLDOWN_MINUTES
- Trigger rules are edge-triggered (edge state is in-memory, resets on restart — fine: a rule simply re-fires once); a trigger `halt` persists for the process lifetime AND is persisted across restarts via meta risk.state_v1 (restored as-is, unlike the daily-loss halt which clears on a new UTC day). Trigger inputs (rsi/price/sentiment/volatility/atr_pct/stoch_k/stoch_d/macd_hist_pct) are recomputed per symbol in tick before the strategy runs
- Reconciliation (npm run reconcile -> src/reconcile.ts): derive expected active base holdings = open positions − amount resting in open sell orders per base, compare vs the live exchange wallet (PortfolioManager.getHoldings), exit non-zero on drift beyond dust tolerance; requires DRY_RUN=false + live key, read-only
- TradingView intents are consumed asynchronously one per symbol per tick (bounded FIFO, cap 200); BUY skips only the RSI-entry ceiling, SELL needs an open position; TRADINGVIEW_ENABLED defaults false and the endpoint 404s when off; alerts persist in tradingview_signals
- SignalBroker is the single ingestion point: all external intents (sentiment/trade) flow through submit(); sentiment aggregation stays in SentimentEngine (the broker's sentiment subscriber); trade intents include source (tradingview|manual|scheduled) for audit
- Multi-bot: BOTS_JSON entries are env-override objects merged over base env; each bot gets its own DB_PATH/poll loop/risk/strategy pool (isolation); SENTIMENT_WEBHOOK_PORT=0 disables that bot's webhook; bots share only the logger and the process

- Market making (MM_ENABLED + STRATEGY_POOLS={"symbol":"mm"}): only passive limit orders via gateway.placeLimit -> db.insertOrder(kind mm_bid/mm_ask/mm_exit); no inventory -> bid only, after a bid fill both sides; bid amount capped by (MM_MAX_INVENTORY_VALUE - invValue)/mid so a fill never overshoots the cap; stale quotes (MM_MAX_QUOTE_AGE_SECONDS) cancelled then requoted; fill cooldown MM_COOLDOWN_SECONDS; stop-loss market-sells kind mm_exit when mid < cost*(1 - MM_STOP_LOSS_PCT/100). Since P3-5 the in-memory inventory/costBasis is mirrored to meta mm.state.<pairKey> (persist on mutation) and re-adopted on boot (restore: open positions + meta cost basis + resting quote ids from openOrders) so a restart doesn't re-buy stopped-out inventory; DB positions are still written by the executor on real fills. Dry-run executor fills a resting limit when the crossed side of the best price crosses the limit (buy: best ask <= limit; sell: best bid >= limit)
- Live resting orders (executor/MM): fill accounting follows the documented orders/status contract — statuses New|Active|Inactive|Done|Canceled, monetary fields as decimal strings incl. 0E-10; matchedAmount > 0 while Active or on Canceled means a partial fill, booked exactly once at the terminal state (averagePrice when present, else the limit price); a cancel that raced a fill or failed returns false from gateway.cancel so MM keeps polling the id and never loses or double-books inventory; the /v2/market/orders/list paging fallback idea is obsolete (clientOrderId lookup is the documented backup)
- Arbitrage (ARB_ENABLED + ARB_SYMBOLS map): per tick compares fee-adjusted round trips in both directions vs the external book scaled by ARB_FX_RATE (0=1); legs are plain spot round trips (buy/sell same symbol, opposite legs on the second exchange; NO holding-account concept); dry-run simulates both legs locally and never calls the second exchange; live requires USER_ARB_API_KEY/SECRET (config-validated when ARB_ENABLED && !DRY_RUN) and checks the sell-side wallet; second-exchange leg failures are caught by the caller so a remote error never crashes the tick; BinanceArbClient deliberately thin (no nonce cache — acknowledged auth risk)
- Boolean envs use boolEnv() (config.ts): only "true"/"1"/"yes"/"on" are true and "false"/"0"/"no"/"off" are false; do NOT use z.coerce.boolean() which mis-parses the string "false" as true (that latent bug made DRY_RUN=false impossible to set via env)
