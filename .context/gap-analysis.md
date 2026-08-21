# Gap Analysis — our bot vs Cryptohopper

Updated: 2026-08-21
Sources: cryptohopper.com, docs.cryptohopper.com/docs (trading-bot, my-library), pricing schema.

Legend: HAVE = we already have (possibly partial) | GAP = missing | PARTIAL = exists but limited

## Feature surface comparison

| # | Cryptohopper feature | Status | Notes |
|---|----------------------|--------|-------|
| 1 | Multi-exchange support (16+) | GAP | We are Nobitex-only. OK by design (Iran rial market); would need exchange abstraction |
| 2 | Portfolio / trading terminal (positions, orders, history in one dashboard) | PARTIAL | `PortfolioManager` + SQLite give data; no web/CLI dashboard UI, no short tab |
| 3 | Paper trading | HAVE | `DRY_RUN=true` simulates fills on best bid/ask |
| 4 | Base config buy settings (coin selection, buy strategy, spend amount, DCA, safety orders) | PARTIAL | Coin list (SYMBOLS), spend % (position size). Missing: DCA, safety orders, per-buy strategy choice |
| 5 | Base config sell settings (sell strategy, %, take-profit, trailing) | PARTIAL | Fixed SL/TP % + RSI/sentiment exits. Missing: trailing stop/sell, %-based sell sizing |
| 6 | Dollar Cost Averaging (DCA) | GAP | No averaging-down safety orders on losing positions |
| 7 | Trailing stop-loss / trailing take-profit | GAP | Only fixed SL/TP at entry ± pct |
| 8 | Config pools (multiple bot configs, batch coins) | GAP | One global config only |
| 9 | Third-party signals (subscribe + execute) | PARTIAL | We ingest sentiment webhook/JSONL; no formal "signal" subscriptions or signal→action mapping |
| 10 | Triggers engine (custom condition → action: notify/buy/sell/short) | GAP | No rule engine; exits hard-coded |
| 11 | Short selling | GAP | Spot only; Nobitex has margin API (future) |
| 12 | Strategy Designer / Builder (visual indicator combos) | GAP | Single hard-coded hybrid strategy |
| 13 | Technical indicators library + candle patterns | PARTIAL | Only RSI + volatility computed locally |
| 14 | Algorithm Intelligence (AI strategy, trainable) | GAP | No ML/AI strategy |
| 15 | Backtester | GAP | Nothing; strategy never validated on history |
| 16 | TradingView Alerts integration (webhook → trade) | GAP | No TradingView webhook endpoint |
| 17 | Market Making bot | GAP | No dual-side order placement |
| 18 | Exchange / market arbitrage | GAP | No arbitrage logic |
| 19 | Copy trading (Copy Bot) | GAP | No follower-of-trader mode |
| 20 | Bulk Bot Manager (multi-bot orchestration) | GAP | One bot process |
| 21 | Performance stats page (win rate, profit factor, drawdown, global stats) | PARTIAL | Daily report only; no derived performance metrics |
| 22 | Trade history export (CSV) | GAP | Data in SQLite only; no export |
| 23 | Backtesting/paper differences documented + auto-sync | PARTIAL | Wallets refreshed each tick (= auto-sync); no history import |
| 24 | Notifications (push/email) | PARTIAL | Telegram only |
| 25 | Charts + technical/fundamental analysis | GAP | No charting/TA visualization |
| 26 | Marketplace / social trading / tournaments / affiliate | GAP | Out of scope (platform business model) |
| 27 | Mobile apps | GAP | Out of scope for v1 |
| 28 | Taxes & reporting | PARTIAL | Daily report + audit DB; no tax export |
| 29 | MCP / AI assistant integration | GAP | Not applicable to our on-prem bot |

## Where we are STRONGER or equal

- Risk management is explicit and enforced in-code (position size, exposure, volatility gate, daily loss halt, trade caps) — Cryptohopper relies on user-set config, not hard limits.
- Full audit trail on every signal/order/risk event (SQLite) — Cryptohopper keeps history but not a decision-level audit.
- Sentiment-from-verified-accounts is a data source Cryptohopper does not offer natively.
- Safety defaults (dry-run, trading disabled) are unusual for the category.
- Nobitex-specific (rial markets) — Cryptohopper does not support Nobitex at all.

## Priority ranking for implementation (value / effort)

| Rank | Feature | Value | Effort | Justification |
|------|---------|-------|--------|---------------|
| 1 | Backtester | high | medium | Validates the strategy before risking capital; reuses OHLC endpoint + audit schema |
| 2 | Performance analytics + CSV export | high | low | Turns audit DB into decisions; profit factor, drawdown, win rate |
| 3 | Trailing stop/take-profit | high | low-medium | Directly improves exit quality, reuses position monitor loop |
| 4 | DCA (averaging down) | medium-high | medium | Marketed core feature; needs new buy-ladder config + position augmentation |
| 5 | Trigger engine (rule DSL) | high | medium | Replaces hard-coded exits; enables price/news/RSI/sentiment conditions |
| 6 | Strategy DSL (declarative multi-indicator) + config pools | high | medium-high | Generalizes the hybrid strategy; move to config-driven |
| 7 | TradingView webhook endpoint | medium | low | Cheap to add; reuses sentiment webhook infra |
| 8 | Signals framework (subscription → action) | medium | medium | Formalize third-party signal ingestion beyond sentiment |
| 9 | Short selling via Nobitex margin API | medium | high | Needs margin endpoints + different risk model |
| 10 | Market making / arbitrage | medium | high | Complex, needs orderbook depth + maker fills |
| 11 | Copy trading | low-med | high | Requires social/leaderboard infra; skip for personal bot |
| 12 | Multi-exchange abstraction | low | high | Nobitex-only requirement; skip unless scope changes |

## Out of scope (deliberately)

Marketplace, social/chat, tournaments, affiliate, mobile apps, charting SaaS, multi-exchange.
