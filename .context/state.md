# State — 2026-08-26

## Intent    — implement P2-1 Strategy DSL + config pools (Cryptohopper parity, Phase 2) and keep `.context/` updated at each step
## Touched   — src/indicators.ts — calculateSMA / calculateEMA added (null on insufficient data; EMA seeds from SMA of first `period`) — done
## Touched   — src/strategy/dsl.ts — created: DslStrategy (zod-validated DslJson: warmupSamples/entry/exit trees), node evaluator exported as evaluateNode; same risk gates + DCA as hybrid; warmup = max(rsiPeriod+5, maxMaPeriod+1, warmupSamples); DSL entries skip the hybrid RSI ceiling via skipRsiGate — done
## Touched   — src/config/pools.ts — created: parseStrategyPools (symbol -> "hybrid"|DSL, zod-validated) + buildStrategyPool (Map<string, StrategyLike>, shared hybrid instance when no DSL override) — done
## Touched   — src/config.ts — STRATEGY_POOLS env (default "{}"), BotConfig.strategyPools, cross-validated against SYMBOLS (unknown symbol rejected) — done
## Touched   — src/risk/manager.ts — evaluateBuy gained optional `{skipRsiGate}` option; hybrid passes default (false), DSL passes true — done
## Touched   — src/index.ts + src/backtest/engine.ts — decisions and backtest replay resolve strategy via buildStrategyPool (single code path) — done
## Touched   — .env.example + README.md — STRATEGY_POOLS docs: node table, example, backtest note — done
## Touched   — tests/dsl.test.ts — created: 13 tests (parse/evaluateNode semantics, warmup, entry buy, entry-not-met hold, exit sell, price>MA trend entry with high RSI, no-entry-rule hold, pool parse/validation x3, per-symbol pool assignment, config unknown-symbol rejection) — done
## Touched   — .context/implementation-plan.md — P2-1 marked DONE — done
## Decisions — DSL nodes stay deliberately small: rsi/volatility/sentiment thresholds, price vs SMA|EMA, and/or/not; DCA + fixed stop/trailing/take-profit always apply on top (safety first)
## Decisions — DSL entries bypass the hybrid RSI-entry ceiling (trend/MA strategies must not be blocked by high RSI); volatility/exposure/cooldown/capital gates still enforced
## Decisions — strategy pools are static per symbol for now; scheduled rotation (Cryptohopper schedule-based) deferred to a later P2 iteration
## Verified  — 80/80 tests pass (65 + 2 indicators + 13 dsl); typecheck + build clean
## Open      — P2-2 TradingView webhook endpoint is next in Phase 2 (or user's choice); no persistence of pool assignment beyond env
## Next      — P2-2 TradingView webhook, or user's choice
