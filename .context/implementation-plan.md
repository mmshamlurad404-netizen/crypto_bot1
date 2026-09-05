# Implementation Plan — Cryptohopper feature parity

Updated: 2026-09-05
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

### P2-1 Strategy DSL + config pools — DONE (2026-08-26)
- `src/strategy/dsl.ts`: declarative `DslStrategy` — zod-validated `DslJson` (`warmupSamples`, `entry`, `exit` condition trees); nodes: `rsi_lt/gt`, `volatility_lt/gt`, `sentiment_lt/gt`, `price_gt_ma/price_lt_ma` (`sma|ema` × period), `and`/`or`/`not`; exit tree evaluated while holding, fixed stop-loss/trailing/take-profit always supersede. Warmup = `max(rsiPeriod+5, maxMaPeriod+1, warmupSamples)`.
- `src/indicators.ts`: `calculateSMA`/`calculateEMA` (null on insufficient data; EMA seeds from SMA of first `period`).
- `src/config/pools.ts`: `parseStrategyPools` (`symbol -> "hybrid"|DSL`) + `buildStrategyPool` returning `Map<string, StrategyLike>`; hybrid instance shared when no DSL override.
- Config: `STRATEGY_POOLS` env (default `"{}"`), `BotConfig.strategyPools`, cross-validated against `SYMBOLS`.
- `src/index.ts` + `src/backtest/engine.ts`: decisions/backtest replay resolve strategy via the pool (same code path as live).
- Risk: `evaluateBuy(..., {skipRsiGate})` — DSL entries bypass the hybrid RSI ceiling (trend entries must not be blocked by high RSI); hybrid unchanged.
- Tests `tests/dsl.test.ts` (13: node semantics, warmup, entry/exit, price>MA trend entry, no-rule hold, pool parse/validation/assignment); suite 80/80, typecheck + build clean.

### P2-2 TradingView webhook endpoint — DONE (2026-08-26)
- `src/sentiment/server.ts`: `POST /api/v1/tradingview` (Bearer auth, same token as sentiment) — parses TradingView alert JSON; maps `strategy.order.action`/`action` (`buy|long|entry` -> BUY, `sell|short|close|exit` -> SELL, `hold|none` -> no-op) and resolves the symbol from an explicit `symbol` key or a `ticker` (`BINANCE:BTCRLS` -> `btc/rls`); `close` used as a price hint.
- `src/sentiment/server.ts`: `TradingViewSignals` bounded FIFO store (per symbol, cap 200); endpoint enqueues intents and persists raw alerts to a new `tradingview_signals` table.
- `src/index.ts`: `processTradingViewIntent` drains one pending intent per symbol per tick after the strategy decision — BUY runs `risk.evaluateBuy(..., {skipRsiGate:true})` (halted/cooldown/volatility/exposure/trade-cap/min-value gates; no RSI ceiling for explicit alerts), SELL requires an open position; decisions flow through the shared `executeDecision` path and every intent (incl. blocked/ignored) is recorded in `signals`.
- Config: `TRADINGVIEW_ENABLED` (default false, opt-in; endpoint 404s when off) — no new token/port env (reuses `SENTIMENT_WEBHOOK_TOKEN`/port).
- Docs: `.env.example` + README section + `scripts/feed_tradingview.sh`.
- Tests `tests/tradingview.test.ts` (9: parse mapping buy/sell/ticker, hold no-op, rejections, FIFO store, HTTP endpoint enqueue+persist, auth 401, disabled 404, unknown symbol 400); suite 89/89, typecheck + build clean.

### P2-3 Signals framework — DONE (2026-08-26)
- `src/signals/broker.ts`: `SignalBroker` — unified `SignalIntent` model (`kind: sentiment|trade`, `source: sentiment-webhook|sentiment-feed|tradingview|manual|scheduled`); sentiment intents routed to a registered subscriber (returns the ingest result), trade intents queued per symbol in a bounded FIFO (cap 200) and drained via `shiftTrade`; `submit`/`stats` for observability.
- `src/sentiment/server.ts`: refactored off direct `SentimentEngine`/`TradingViewSignals` — the webhook (sentiment + TradingView + JSONL feed) now only validates payloads and `submit()`s intents to the broker; API response shapes unchanged. `parseTradingViewAlert` returns a `TradeIntent`.
- `src/index.ts`: broker wired as the single ingestion point — `onSentiment` → `SentimentEngine.ingest`; tick drains `signals.shiftTrade(pair.key)` into `processTradingViewIntent` (unchanged risk-gated path).
- Tests: `tests/signals.test.ts` (5: sentiment routing + result, missing-sentiment rejection, trade FIFO/queue/drain, BUY/SELL + unknown-kind rejection, no-subscriber acceptance) + `tests/tradingview.test.ts` updated to the broker (parse→TradeIntent, endpoint enqueue via broker, sentiment-endpoint-through-broker end-to-end into `sentiment_events`); suite 94/94, typecheck + build clean.

## Phase 3 — Stretch (only if earlier phases land clean)

### P3-1 Multi-bot orchestration — DONE (2026-08-26)
- `src/config.ts`: `BOTS_JSON` env (JSON array of env-override objects, merged over base env) + `loadConfigs()` → `BotConfig[]`; single config when unset. `BOT_NAME` env (default `default`); `SENTIMENT_WEBHOOK_PORT` now allows 0 (webhook disabled).
- `src/index.ts`: extracted `startBot(config, logger)` — the full per-bot graph (db, feed, sentiment, broker, webhook, portfolio, risk, executor, DCA, triggers, strategy pool, notifier, reporter, poll loop) with its own tick/executeDecision/processTradingViewIntent closures + `stop()`; `main()` starts one bot per config from `loadConfigs()` and stops all on SIGINT/SIGTERM. Each bot uses its own `DB_PATH`.
- Docs: `.env.example` (BOT_NAME, BOTS_JSON, webhook-port-0) + README "Multi-bot orchestration" section.
- Tests `tests/bots.test.ts` (5: single default, N merged configs incl. per-bot port/symbol/name + inherited defaults, inherited SYMBOLS, malformed BOTS_JSON rejections, port-0 + BOT_NAME); suite 99/99, typecheck + build clean.

### P3-2 AI strategy advisor — DONE (2026-08-30)
- `src/strategy/ai.ts`: `AiAdvisorStrategy implements StrategyLike` (async `evaluate` → `SignalDecision`), `HttpLlmClient` (OpenAI-compatible `/chat/completions`, `parseAdvice` extracts the first JSON object and clamps confidence). Context snapshot = last `contextBars` closes + rsi/volatility/sma20/sma50/ema20/sentiment/position/riskLimits; `minIntervalMs` throttle; warmup `< rsiPeriod+5`; LLM errors → HOLD; SELL ignored without an open position; BUY skipped while a position is open; BUY passes `risk.evaluateBuy(skipRsiGate)`.
- `src/config/pools.ts`: `StrategySpec = {kind:"hybrid"}|{kind:"ai"}|{kind:"dsl";dsl}`; `StrategyLike.evaluate` now returns `SignalDecision | Promise<SignalDecision>`; `buildStrategyPool` takes `StrategyPoolDeps.ai: AiAdvisorConfig | null` and builds one shared `aiStrategy` (hybrid fallback when `ai` null); `parseSpec` accepts the string `"ai"`.
- `src/config.ts`: `USER_LLM_API_KEY` (default ""), `USER_LLM_BASE_URL` (default `https://api.deepseek.com/v1`), `USER_LLM_MODEL` (default `deepseek-chat`), `AI_ADVISOR_MIN_INTERVAL_SECONDS` (default 300), `AI_ADVISOR_CONTEXT_BARS` (default 40); validation rejects `"ai"` in pools without `USER_LLM_API_KEY`.
- `src/backtest/engine.ts`: `runBacktest` is now `async` (pool interface is promise-capable), passes `ai: null` — no LLM in backtests; `backtest/run.ts` + `tests/backtest.test.ts` await it.
- Docs: `.env.example` AI-advisor block + README "AI advisor" section.
- Tests `tests/ai.test.ts` (9: parseAdvice, BUY-approved/risk-blocked/position-open, SELL-with/without position, HOLD, throttle, warmup+error, pools+config validation); suite 108/108, typecheck + build clean.

### P3-3 Short selling via margin API — DONE (2026-08-31)
- Config (all default OFF): `MARGIN_ENABLED` (false), `MARGIN_LEVERAGE` (2), `MARGIN_MAX_SHORT_PCT` (10), `MARGIN_SYMBOLS` ("" = all), `MARGIN_STOP_LOSS_PCT`/`MARGIN_TAKE_PROFIT_PCT`, `RSI_SHORT_ENTRY_FLOOR` (65) → `BotConfig.margin: MarginConfig` + `rsiShortEntryFloor`.
- Types: `SignalAction` += `SHORT`|`COVER`; `MarginPosition`/`MarginPositionWithValue`; `PortfolioState.marginPositions`.
- DB: `margin_positions` table + insert/open/close/closedBetween methods.
- Exchange: `marginBalance`, `marginAddOrder`, `marginOrderStatus`, `marginCloseOrder` (`/v2/margin`, `/v2/margin/orders/add|status|close`).
- Risk: `evaluateShort` (mirror of `evaluateBuy` with inverted RSI floor; blocks when ANY position open via `hasAnyOpenPosition` — spot BUY also blocked while short open); `checkMarginStopLoss`/`checkMarginTakeProfit` (inverted); `checkMarginTrailingStops` (trough-tracked); optional config fields with constructor defaults.
- Portfolio: short unrealized pnl in `equity()`, margin value in `positionsValue`, `marginPositionsWithValue()`; `applyMarginOpen` inserts the short; `applyMarginClose` realizes `(entry−price)×amount` and credits the quote wallet (so realized short PnL shows up in equity).
- Executor: `execute` gained a `mode: spot|margin` + `kind: string`; `openShort`/`coverShort` route to `marginAddOrder`/`applyMarginOpen`/`applyMarginClose`.
- Strategy: `HybridStrategy` takes a `MarginStrategyConfig`; emits SHORT (RSI≥overbought + sentiment≤−entry threshold) and COVER (sentiment turn / RSI≤entry ceiling / margin stop/tp/trailing).
- Pool + index.ts: `StrategyPoolDeps.margin`; `executeDecision` SHORT/COVER branches; tick records them in `signals`.
- Backtest: `runBacktest` handles SHORT/COVER round trips (shorts in `roundTrips`, `sells`/`buys` map to open/cover).
- Docs: `.env.example` margin block + README "Short selling via margin".
- Tests `tests/margin.test.ts` (10: config, risk gates/blocked-positions, margin stop/tp, portfolio equity+realized, executor dry-run + failed margin order, strategy SHORT/COVER + stop-loss cover, backtest profitable short); suite 118/118, typecheck + build clean.

### P3-4 Market making / arbitrage — DONE (2026-09-02)
- Config (all default OFF): `MM_ENABLED`/`MM_SYMBOLS`/`MM_SPREAD_PCT`/`MM_ORDER_VALUE`/`MM_MAX_INVENTORY_VALUE`/`MM_STOP_LOSS_PCT`/`MM_COOLDOWN_SECONDS`/`MM_MAX_QUOTE_AGE_SECONDS`/`MM_MIN_ORDER_VALUE` → `BotConfig.mm`; `ARB_ENABLED`/`ARB_EXCHANGE`/`ARB_SYMBOLS`/`ARB_FX_RATE`/`ARB_MIN_PROFIT_PCT`/`ARB_MAX_NOTIONAL_PCT`/`ARB_COOLDOWN_SECONDS` + `USER_ARB_API_KEY`/`USER_ARB_API_SECRET` → `BotConfig.arb`. Validation rejects unknown MM/ARB symbols and live (`DRY_RUN=false`) arb without second-exchange creds. Also replaced `z.coerce.boolean()` with a `boolEnv()` preprocess so the string `"false"` parses to `false` (latent bug: `DRY_RUN=false` used to coerce to `true`).
- Execution: new `OrderGateway` interface (`src/execution/gateway.ts`) implemented by `Executor` — `placeLimit`/`cancel`/`poll` resting limit orders (dry-run fills when best price crosses the limit; live poll detects immediate fills/partials) with `applyLimitFill` routed through AuditDb + `PortfolioManager.applyTrade` + `RiskManager.recordTrade`; exported `pairFromKey`.
- Market making `src/strategy/mm.ts` (`MarketMakingStrategy`, opt-in per symbol via `STRATEGY_POOLS={"btc/rls":"mm"}`): per-pair state, bid-only when no inventory, both sides after a bid fill, inventory-aware skew capped by `MM_MAX_INVENTORY_VALUE` (fill cannot overshoot), stale-quote cancel+requote, fill cooldown, stop-loss market close; `manage()` runs per tick; backtest sim gateway fills at limit intra-bar.
- Arbitrage `src/strategy/arb.ts` + `src/exchange/arb.ts`: bidirectional fee-adjusted comparison vs Binance bookTicker (`BinanceArbClient`, signed market legs gated on creds), equity-sized legs, cooldown, dry-run simulates round trips locally (never contacts the 2nd exchange), live checks sell-side balance first and remote-leg errors never crash the tick; plain spot round trips, no holding-account concept; excluded from backtests.
- Docs: `.env.example` MM/ARB blocks + README "Market making (resting quotes)" and "Cross-exchange arbitrage" sections.
- Tests `tests/mm.test.ts` (8, rebuilt around the real executor gateway incl. stale-quote requote + max-inventory cap), `tests/arb.test.ts` (8 incl. reverse direction + live inventory gate), plus config bool parsing; suite 137/137, typecheck + build clean. Committed `feat(mm): market making + cross-exchange arbitrage`.

### P3-5 Live hardening & recovery (A) + MACD/Bollinger/ATR/stoch indicators (B) — DONE (2026-09-05)
- Scope chosen from `.context/P3-5-proposal.md`: **A+B**. A = restart/order recovery + reconciliation; B = classic indicators exposed through DSL, trigger engine, and AI context.
- **A1/A2 risk persistence** `src/risk/manager.ts`: `PersistedRiskState` stored under `meta` key `risk.state_v1` via new `AuditDb.getMetaJSON/setMetaJSON`; halt reason/ts, per-pair cooldowns, trailing stop/TP ratchets, margin trailing state persist on mutation; `restore()` rehydrates. Daily-loss halts clear only when a restart lands on a new UTC day (`halt-cleared`); trigger halts restore (`halt-restored`). Persistence writes are best-effort (never take a tick down).
- **A3 order recovery** `src/execution/executor.ts`: `recoverLiveOrders(): Promise<RecoveryReport>` polls every DB order still `new`, books down-time fills exactly once via `poll()`, marks canceled/failed, skips dry-run/live mode-mismatched rows.
- **A4 MM rehydration** `src/strategy/mm.ts`: per-pair `meta` keys `mm.state.<pairKey>` persist costBasis/lastFillAt; `restore()` re-adopts inventory from open positions, cost basis from meta (or entry price), resting quote ids/timestamps from `db.openOrders` (`mm_bid`/`mm_ask`).
- **Boot wiring** `src/index.ts`: `StrategyLike.restore?()` optional; `buildStrategyPool` passes `allKeys` to MM; `startBot` runs `executor.recoverLiveOrders()` + per-strategy `restore?.()` in an async `boot()` before the first `tick()`.
- **A5 reconciliation** `src/reconcile.ts` + npm script `reconcile`: `deriveSpotExpectation` (open positions − amount resting in open sell orders per base), compare vs `PortfolioManager.getHoldings()`, `formatReport`, exit 1 on drift; skips `DRY_RUN=true` bots.
- **B1 indicators** `src/indicators.ts`: `emaSeries`, `calculateMACD` (12/26/9), `calculateBollinger` (20/2), `calculateStoch` (14/3), `calculateCloseRangePct` (close-range ATR proxy), `computeRichIndicators` incl. `macdHistPct` (hist/price) + bands; deterministic on close-only series; history gaps → null.
- **B2 DSL nodes** `src/strategy/dsl.ts`: `macd_hist_pct_lt/gt`, `stoch_k_lt/gt`, `stoch_d_lt/gt`, `atr_pct_lt/gt`, `boll_pct_lt/gt`; zod updated; warmup ≥45 when advanced nodes present; `hasAdvancedNodes` picks rich vs base indicator path.
- **B3 triggers** `src/triggers/engine.ts` + `src/config.ts` + `src/index.ts`: new `TriggerConditionTypes` (`volatility_above/below`, `atr_pct_*`, `stoch_k_*`, `stoch_d_*`, `macd_hist_pct_*`); `volatility` added to `TriggerInput`; `currentValue`/`conditionMet` handle all; rich indicators computed only when configured triggers need them (`richIndicatorTriggerTypes`).
- **B4 AI context** `src/strategy/ai.ts`: LLM snapshot now includes `macdHistPct`, `atrPct`, `stochK/stochD`, nested `bollinger{upper,middle,lower}`.
- Tests: `tests/recovery.test.ts` (7), `tests/indicators.test.ts` (7), `tests/dsl.test.ts` +6, `tests/triggers.test.ts` +4, `tests/ai.test.ts` snapshot assertions. Suite **158/158**, typecheck + build clean. Docs updated (`.env.example` trigger/DSL/ops blocks, README trigger table, DSL nodes, AI snapshot, restart-safety & reconciliation sections).

## Explicitly NOT planned
Multi-exchange abstraction, marketplace/social/mobile/charting SaaS, copy trading, taxes reporting.

## Verification per phase
- Unit tests for every new module (node:test, in-memory DB).
- `npm run typecheck` clean; `npm run build` clean.
- Backtester + export validated against a 90-day live Nobitex history pull.
- All new behavior gated behind env flags defaulting to safe/off.
