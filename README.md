# Nobitex Sentiment Bot

A hybrid crypto trading bot for the [Nobitex](https://nobitex.ir) exchange that:

- Consumes real-time sentiment pushed from verified accounts (webhook + JSONL feed)
- Trades on a **hybrid strategy**: sentiment sets the bias, RSI timing triggers entry/exit
- Enforces **risk limits** (position size, total exposure, volatility gate, daily loss/trade caps)
- Includes **portfolio management** (equity tracking, position sizing, PnL, snapshots)
- Sends **alerts and a daily report** to Telegram
- **Logs every signal, order, fill, risk event and snapshot** to SQLite for audit
- Integrates with your Nobitex account using a scoped API token over HTTPS

> Defaults are safe: `DRY_RUN=true` (simulated fills) and `TRADING_ENABLED=false`
> (signals only). Turn both on only after you are confident in the configuration.

## Architecture

```
src/
  index.ts              # orchestrator: poll loop, execution, scheduling
  config.ts             # typed env config (zod)
  logger.ts             # pino logger
  db.ts                 # SQLite audit store (better-sqlite3)
  types.ts              # shared types
  exchange/nobitex.ts   # Nobitex REST client (apiv2.nobitex.ir)
  market/priceFeed.ts   # price series per symbol (seeded from recent trades)
  indicators.ts         # RSI (Wilder) + volatility
  sentiment/engine.ts   # recency/confidence-weighted aggregation
  sentiment/server.ts   # HTTP webhook + JSONL file feed
  strategy/hybrid.ts    # sentiment + RSI entry/exit rules
  risk/manager.ts       # risk limits, position sizing, halt logic
  portfolio/manager.ts  # holdings, equity, PnL, positions
  execution/executor.ts # order placement (dry-run simulation / live)
  alerts/telegram.ts    # Telegram notifier
  alerts/report.ts      # daily report + portfolio snapshot
  backtest/             # history loader + strategy replay engine + CLI
```

```
Market data (public) ──► PriceFeed ──► RSI / volatility
                                         │
Sentiment webhook / JSONL ──► Engine ────┤
                                         ▼
                                   HybridStrategy ──► RiskManager (limits)
                                         │                  │
                                         ▼                  ▼
                                     Executor ──► PortfolioManager ──► SQLite
                                         │
                                         ▼
                                    Telegram alerts + daily report
```

## Quick start

```bash
npm install
cp .env.example .env       # then edit .env
npm run dev                # starts bot + sentiment webhook on :3001
```

In another terminal, feed sentiment from verified accounts:

```bash
chmod +x scripts/feed_sentiment.sh
WEBHOOK_TOKEN=<your-token> ./scripts/feed_sentiment.sh
```

Watch the bot evaluate signals in the log. With the default config it will only
simulate; nothing is sent to the exchange until you opt in.

### JSONL file feed (optional)

Set `SENTIMENT_JSON_FEED=/path/to/feed.jsonl`. The bot re-reads the file when it
changes. One JSON object per line:

```json
{"account":"@verified1","symbol":"btc","sentiment":0.7,"confidence":1.0,"note":"...","timestamp":1690000000000}
```

### Webhook contract

```
POST /api/v1/sentiment
Authorization: Bearer <SENTIMENT_WEBHOOK_TOKEN>
Content-Type: application/json

{ "account": "@verified1", "symbol": "btc", "sentiment": 0.7, "confidence": 1.0, "note": "..." }
```

Accepts a single object or an array. `sentiment` is clamped to `[-1, 1]`,
`confidence` to `[0, 1]`. `timestamp` defaults to now. `GET /healthz` returns `{"status":"ok"}`.

## Strategy (hybrid: sentiment + RSI)

**Entry (BUY)** when all hold:

1. Aggregate sentiment for the symbol >= `SENTIMENT_ENTRY_THRESHOLD` (bullish bias)
2. `RSI < RSI_ENTRY_UPPER` (price is dipping, not chasing)
3. Risk manager approves the order

**Exit (SELL)** when any holds:

1. Stop-loss: price <= entry × `(1 - STOP_LOSS_PCT/100)`
2. Take-profit: price >= entry × `(1 + TAKE_PROFIT_PCT/100)`
3. Sentiment <= `SENTIMENT_EXIT_THRESHOLD`
4. `RSI >= RSI_OVERBOUGHT`

Sentiment is aggregated as a weighted mean over a sliding window; weights are
`confidence × exp(-age/half_life)`, so recent high-confidence signals dominate.

## Risk management

All enforced before any order:

| Limit | Config | Behaviour |
|---|---|---|
| Max position size | `MAX_POSITION_SIZE_PCT` | Rejects orders above % of equity |
| Max total exposure | `MAX_TOTAL_EXPOSURE_PCT` | Caps sum of all open positions |
| Volatility gate | `VOLATILITY_MAX` | Skips entries on overly volatile assets |
| Volatility sizing | `VOLATILITY_BENCHMARK` / `VOLATILITY_SIZE_CAP` | Shrinks size as volatility rises |
| Daily loss limit | `MAX_DAILY_LOSS_PCT` | Halts trading for the day |
| Daily trade cap | `MAX_TRADES_PER_DAY` | Limits number of trades per day |
| Min order value | `MIN_ORDER_VALUE` | Rejects dust orders |
| Re-entry cooldown | `COOLDOWN_MINUTES` | Per-symbol cooldown after a trade |
| One position per symbol | built-in | No pyramiding by default |

The volatility gate directly addresses the "avoid overexposure to volatile
assets" requirement: entries are skipped when per-sample volatility exceeds
`VOLATILITY_MAX`, and position size is scaled down as volatility rises.

## Security

- The API key is read from the environment (`NOBITEX_API_KEY`) and sent only as
  `Authorization: Token <key>` over HTTPS to `apiv2.nobitex.ir`.
- Create a scoped Nobitex API key: grant **READ** for monitoring; grant **TRADE**
  only when you enable live trading. Never grant withdrawal permissions.
- The webhook requires a `Bearer` token.
- `.env` is git-ignored. Never commit credentials.
- The bot is **audit-first**: every signal, order, fill, risk event, sentiment
  event, and portfolio snapshot is written to `data/audit.db`.

## Audit trail

Tables in `audit.db`:

- `signals` – every strategy decision (action, RSI, sentiment, price, reason)
- `orders` – order lifecycle incl. exchange order id, status, raw error
- `trades` – fills with amount, price, total, fee
- `positions` – open/close lifecycle with entry, exit price and realized PnL
- `risk_events` – every blocked order / halt with the reason
- `sentiment_events` – every ingested sentiment sample
- `portfolio_snapshots` – equity/cash/positions history (each daily report)
- `alerts` – alert delivery log

## Daily report

At `DAILY_REPORT_TIME` the bot sends a Telegram message with equity, cash,
positions, today's realized/unrealized PnL, day change vs previous snapshot,
today's trades, and a per-symbol market + sentiment snapshot. A portfolio
snapshot is persisted at the same time.

## Backtesting

Replays the same `HybridStrategy` + risk gates used by the live bot over
historical bars, so results reflect the exact configuration in `.env` (RSI
period, stop-loss, take-profit, cooldown, exposure, trade caps, fees, ...).

```bash
# 90 days of hourly BTC-RLS bars, constant bullish sentiment 0.5
npx tsx src/backtest/run.ts --symbol btc/rls --days 90 --resolution 60 --sentiment 0.5

# sentiment from a JSONL feed (same format as SENTIMENT_JSON_FEED), 4h bars
npx tsx src/backtest/run.ts --symbol btc/rls --days 90 --resolution 240 --sentiment-file feed.jsonl

# machine-readable output for further analysis
npx tsx src/backtest/run.ts --symbol btc/rls --days 30 --sentiment 0.5 --json
```

Run `--help` for all options. Output: return, win rate, profit factor, max
drawdown, and per-round-trip detail with `--verbose`.

Notes:

- A sentiment source is required (`--sentiment` constant, or
  `--sentiment-file`). With neutral sentiment the entry gate never fires.
- The exchange retains ~500 bars per symbol, so `resolution` bounds the span:
  60m ≈ 21 days, 240m ≈ 83 days.
- Fills are simulated at the bar close; no order-book spread is modeled, and
  the current bar is included in indicators (close-based).
- The backtest uses an in-memory database only — it never touches `data/audit.db`
  and never places orders.

## Tests

```bash
npm test              # indicators, sentiment, risk, strategy, backtest
npm run typecheck     # tsc --noEmit
npm run build         # compile to dist/
```

## Production notes

- Start with `npm run start` (or build + `npm run serve`) under a process manager.
- Keep `DRY_RUN=true` for a while and review `audit.db` before going live.
- The rial markets on Nobitex are quoted in full rial units; the bot uses the
  exchange's `latest`/`bestBid`/`bestAsk` from `GET /market/stats` for pricing.
- Rate limits: the client throttles public market calls and re-uses one session
  for authenticated calls. Market orders are used for entry/exit in v1.

## Disclaimer

This software is provided for educational and research purposes. Cryptocurrency
trading carries substantial risk of loss. You are responsible for your own
trading decisions, strategy parameters, and compliance with applicable laws.
The bot executes only what the configured rules dictate within the configured
risk limits; it cannot prevent losses beyond those limits.
