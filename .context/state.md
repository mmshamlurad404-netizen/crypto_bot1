# State — 2026-09-02

## Intent    — finish P3-4 market making (resting quotes) + cross-exchange arbitrage (Nobitex <-> Binance), both default OFF, with tests/docs and a pushed commit
## Touched   — src/config.ts — MM/ARB env schema + MmConfig/ArbConfig + BotConfig.mm/arb + validation (unknown symbol in MM_SYMBOLS/ARB_SYMBOLS rejects; live arb requires USER_ARB_API_KEY/SECRET); boolEnv() preprocess replaces z.coerce.boolean() so the string "false" actually parses false (was a latent bug: DRY_RUN=false coerced to true) — done
## Touched   — src/execution/gateway.ts — new OrderGateway interface (getBestPrices/getLatestPrice/getBalance/placeLimit/cancel/poll/market) — done
## Touched   — src/execution/executor.ts — implements OrderGateway; limit resting support placeLimit/cancel/poll via NobitexClient.addOrder+orderStatus, dry-run crossed-price fill check, live poll immediate-fill/partial detection, applyLimitFill routes through AuditDb + PortfolioManager.applyTrade + RiskManager.recordTrade; exports pairFromKey — done
## Touched   — src/db.ts — getOrder column-mapping fix; mapOrder + db.openOrders() helper — done
## Touched   — src/strategy/mm.ts — MarketMakingStrategy (StrategyLike, manage per pair): per-pair state (inventory/costBasis/bid+ask order ids/timestamps), inventory-aware skew, bid-only with no inventory then both sides, order-layer fill/replace without cancel, stop-loss market close via gateway, cooldown, max-quote-age cancel via now(), defaults now/halted/tradingActive — done
## Touched   — src/strategy/arb.ts — ArbitrageStrategy.manage(): bidirectional fee-adjusted comparison, ARB_MAX_NOTIONAL_PCT sizing on equity, cooldown map, dry-run legs simulated locally (never touches 2nd exchange), live sell-side inventory check, remote leg calls throw-but-are-caught; Direction.buyNobitex flag drives legs; monitor-only via tradingActive — done
## Touched   — src/exchange/arb.ts — ArbExchangeClient interface + BinanceArbClient (fetch bookTicker, signed marketBuy/marketSell/getBalance with credential requirement, 3s in-flight safety window) — done
## Touched   — src/config/pools.ts — parseSpec/StrategyPoolDeps accept mm|arb; deps gain gateway/+mm/+arb/+arbClient/+nobitexClient/+tradingActive/+dryRun/+feePct; buildStrategyPool falls back to hybrid when mm/arb optional deps missing; error msg now lists mm/arb — done
## Touched   — src/index.ts + src/backtest/engine.ts — tick/backtest call strategy.manage?.(pair); gateway.setBar before each in-engine bar — done
## Touched   — src/backtest/gateway.ts — sim gateway (in-engine bars, MM fills at limit price intra-bar, market exit support, feeds DB via portfolio+risk); src/market/priceFeed.ts — setBar used by backtest — done
## Touched   — tests — mm.test.ts rebuilt around the real executor gateway (inventory through real DB positions), arb.test.ts (dry-run reverse direction simulated, not external), dsl.test.ts parse-error string — done
## Touched   — .env.example + README.md — MM/ARB blocks + "Market making" + "Cross-exchange arbitrage" sections — done
## Touched   — .context/implementation-plan.md — P3-4 marked DONE — done
## Decisions — MM bid/ask placement ONLY via gateway.placeLimit -> db.insertOrder (kind mm_bid/mm_ask/mm_exit); fills recorded via the existing position+risk+portfolio path (no separate quote cache) so daily gates and halts keep working
## Decisions — MM is poll-driven resting quotes with requote (same params -> update, no cancel); a crossed dry-run/poll fill is what generates inventory; strategy never reads balances (executor applies fills to DB positions)
## Decisions — arb legs are plain spot round trips in the normal Nobitex wallet (buy/sell same symbol, opposite legs on the 2nd exchange); NO separate holding-account concept
## Decisions — 2nd-exchange credentials are user-supplied env (USER_ARB_*); Binance client deliberately thin (no nonce cache — auth risk acknowledged); marketBuy/marketSell/getBalance throw when creds missing; live arb legs wrapped so a remote failure never crashes the tick
## Decisions — dry-run arb writes both DB trades + applyArbRoundTrip realization (consistent with existing dry-run behavior); arbitrage excluded from backtests (backtest scope = MM-only via pool check); hybrid remains default strategy; mm/arb are opt-in per symbol via STRATEGY_POOLS
## Decisions — getOrder fallback plan (generic /v2/market/orders/list paging) deferred: dry-run and backtests exercise the poll path; live Executor.poll reports "new" when the native status call lacks the order
## Verified  — 137/137 tests pass (added: 8 mm incl. executor-gateway + stale-quote + max-inventory-cap, arb incl. reverse-direction + live inventory gate); typecheck + build clean
## Open      — (none)
## Next      — commit P3-4 (feat(mm): market making + cross-exchange arbitrage) + push; then P3-5 planning (TBD)
