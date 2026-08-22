# State — 2026-08-22

## Intent    — implement P1-1 Backtester (Cryptohopper parity, Phase 1) and keep `.context/` updated at each step
## Touched   — src/backtest/data.ts — created: UDF history loader (paged) + JSONL sentiment loader — done
## Touched   — src/backtest/engine.ts — created: runBacktest replays strategy+risk on injectable clock, paper portfolio — done
## Touched   — src/backtest/run.ts — created: CLI (symbol/days/resolution/sentiment/sentiment-file/json/verbose/help) — done
## Touched   — tests/backtest.test.ts — created: 6 tests (win/loss/flat/UDF mapping/symbol map) — done
## Touched   — src/exchange/nobitex.ts — added udfHistory() (UDF OHLC, public-throttled) — done
## Touched   — src/market/priceFeed.ts — exported toUdfSymbol() (rls→irt), seed uses it — done
## Touched   — src/risk/manager.ts — injectable `now` clock (cooldown/halt/day-key/timestamps) — done
## Touched   — src/portfolio/manager.ts — injectable `now` clock (applyTrade timestamps/day-key) — done
## Touched   — src/sentiment/engine.ts — injectable `now` clock (snapshot/ingest) — done
## Touched   — README.md — added Backtesting section + backtest/ in architecture — done
## Touched   — .context/implementation-plan.md — P1-1 marked DONE with implementation notes — done
## Touched   — .context/map.md — added backtest module, udfHistory/toUdfSymbol, clock-injection + retention gotchas — done
## Decisions — clock injection (optional `now()` param, default Date.now) over a separate backtest strategy copy: replay the same code, no logic drift
## Decisions — backtest uses `:memory:` db only; fills at bar close (no spread); requires explicit sentiment source (constant or file)
## Decisions — exchange retention ~500 UDF bars: document resolution↔span tradeoff (60m≈21d, 240m≈83d) rather than fabricate data
## Verified  — UDF history endpoint returns {s,t,o,h,l,c,v}; 500-bar cap; valid resolutions ≤240; daily/weekly unsupported
## Verified  — 34/34 tests pass; typecheck + build clean; CLI smoke-tested on live BTC-RLS (90d/60m and 90d/240m)
## Open      — whether the constant-sentiment default (0.5 in examples) biases results; user may prefer sentiment-file for realism
## Next      — commit + push backtester; then P1-2 performance analytics + CSV export (or user's choice)
