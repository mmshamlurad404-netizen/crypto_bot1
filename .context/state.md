# State — 2026-08-26

## Intent    — implement P2-3 Signals framework (Cryptohopper parity, Phase 2) and keep `.context/` updated at each step
## Touched   — src/signals/broker.ts — created: SignalBroker + SignalIntent/TradeIntent/SubmitResult types; sentiment intents -> registered subscriber (returns ingest result), trade intents -> bounded per-symbol FIFO drained via shiftTrade; submit/stats — done
## Touched   — src/sentiment/server.ts — refactored off direct SentimentEngine/TradingViewSignals: webhook (sentiment + tradingview + JSONL feed) now validates then submit()s intents to the broker; API response shapes unchanged; parseTradingViewAlert returns TradeIntent (source:"tradingview"); TradingViewSignals class removed — done
## Touched   — src/index.ts — broker is the single ingestion point: onSentiment -> sentimentEngine.ingest; tick drains signals.shiftTrade(pair.key) -> processTradingViewIntent; signal details record intent source — done
## Touched   — README.md — Signals framework section + architecture diagram updated (broker routing) — done
## Touched   — tests/signals.test.ts — created: 5 broker tests (sentiment routing+result, missing-sentiment reject, trade FIFO/queue/drain, BUY/SELL + unknown-kind reject, no-subscriber acceptance) — done
## Touched   — tests/tradingview.test.ts — updated to broker: parse->TradeIntent, endpoint enqueue via broker FIFO, sentiment-endpoint-through-broker end-to-end into sentiment_events — done
## Touched   — .context/implementation-plan.md — P2-3 marked DONE — done
## Decisions — broker is source-agnostic: adding a manual API or scheduled source later is just another submit(); no new env vars (P2-3 is internal plumbing)
## Decisions — sentiment aggregation stays in SentimentEngine (strategy consumes the weighted score); the engine is the sentiment subscriber, not the webhook
## Decisions — trade intents are drained one per symbol per tick (same cadence as the poll loop); bounded FIFO cap 200 prevents unbounded memory from a burst of alerts
## Verified  — 94/94 tests pass (89 + 5 signals + tradingview rewrite); typecheck + build clean
## Open      — Phase 2 complete. Phase 3 stretch items remain (short selling, market making, multi-bot orchestration, AI advisor) — all deliberate non-goals unless requested
## Next      — Phase 3 stretch items, or user's choice
