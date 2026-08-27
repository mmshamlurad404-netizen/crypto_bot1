# State — 2026-08-26

## Intent    — implement P2-2 TradingView webhook endpoint (Cryptohopper parity, Phase 2) and keep `.context/` updated at each step
## Touched   — src/sentiment/server.ts — POST /api/v1/tradingview (Bearer auth, same token); parseTradingViewAlert maps action/strategy.order.action and symbol/ticker; TradingViewSignals bounded FIFO store; alerts persisted + intents enqueued; boundPort() accessor added — done
## Touched   — src/db.ts — tradingview_signals table (ts/symbol/action/price/ticker/raw) + insertTradingViewSignal + countTradingViewSignals — done
## Touched   — src/index.ts — tradingViewSignals store wired to webhook; processTradingViewIntent drains one pending intent per symbol per tick after the strategy: BUY -> risk.evaluateBuy(skipRsiGate) veto, SELL -> requires open position; both route through shared executeDecision; every intent recorded in signals (incl. blocked/ignored) — done
## Touched   — src/config.ts — TRADINGVIEW_ENABLED env (default false, opt-in); tradingViewEnabled in BotConfig — done
## Touched   — .env.example + README.md + scripts/feed_tradingview.sh — TradingView webhook docs + sample client — done
## Touched   — tests/tradingview.test.ts — created: 9 tests (parse buy/sell/ticker/hold, rejection paths, FIFO store, HTTP enqueue+persist, auth 401, disabled 404, unknown symbol 400) — done
## Touched   — .context/implementation-plan.md — P2-2 marked DONE — done
## Decisions — TradingView intents are consumed asynchronously (one per symbol per tick, bounded FIFO), not executed inline in the HTTP handler — keeps webhook decoupled and routes decisions through the normal tick/execution path
## Decisions — BUY intents skip only the RSI-entry ceiling (an explicit alert IS the signal); halt/cooldown/volatility/exposure/trade-cap/min-value gates still apply; SELL requires an open position (no sell risk gate exists in the codebase)
## Decisions — reuses SENTIMENT_WEBHOOK_TOKEN and port (no new secret/port); TRADINGVIEW_ENABLED=false returns 404 to avoid surface when opted out
## Verified  — 89/89 tests pass (80 + 9 new); typecheck + build clean
## Open      — P2-3 Signals framework is next (unified subscriber/intent model; sentiment feed becomes a subscriber) — or user's choice
## Next      — P2-3 Signals framework, or user's choice
