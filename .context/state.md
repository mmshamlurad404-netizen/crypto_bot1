# State — 2026-08-31

## Intent    — implement P3-3 short selling via the Nobitex margin API (default OFF, heavy testing) and keep `.context/` updated at each step
## Touched   — src/config.ts — MARGIN_ENABLED/LEVERAGE/MAX_SHORT_PCT/SYMBOLS/STOP_LOSS_PCT/TAKE_PROFIT_PCT + RSI_SHORT_ENTRY_FLOOR envs; MarginConfig + BotConfig.margin + rsiShortEntryFloor; MARGIN_SYMBOLS-in-SYMBOLS validation — done
## Touched   — src/types.ts — SignalAction += SHORT|COVER; MarginPosition/MarginPositionWithValue; PortfolioState.marginPositions — done
## Touched   — src/db.ts — margin_positions table + insert/open/get/close/closedBetween methods — done
## Touched   — src/exchange/nobitex.ts — marginBalance / marginAddOrder / marginOrderStatus / marginCloseOrder (/v2/margin, /v2/margin/orders/add|status|close) — done
## Touched   — src/risk/manager.ts — evaluateShort (inverted RSI floor), hasAnyOpenPosition (BUY blocked while short open), checkMarginStopLoss/TakeProfit, checkMarginTrailingStops (trough), optional margin fields with constructor defaults — done
## Touched   — src/portfolio/manager.ts — short unrealized pnl in equity(), margin value in positionsValue, marginPositionsWithValue, applyMarginOpen/applyMarginClose (credits realized pnl to quote wallet) — done
## Touched   — src/execution/executor.ts — execute(mode: spot|margin, kind: string); openShort/coverShort — done
## Touched   — src/strategy/hybrid.ts — MarginStrategyConfig; SHORT (RSI>=overbought + sentiment<=-entryThreshold) + COVER (sentiment turn / RSI<=entry ceiling / margin stop/tp/trailing) — done
## Touched   — src/config/pools.ts + src/index.ts — StrategyPoolDeps.margin; executeDecision SHORT/COVER; tick records both in signals — done
## Touched   — src/backtest/engine.ts — SHORT/COVER round trips in runBacktest (sells/buys = open/cover) — done
## Touched   — .env.example + README.md — margin block + "Short selling via margin" section — done
## Touched   — tests/margin.test.ts — created: 10 tests (config, risk gates/blocked-positions, margin stop/tp, portfolio equity+realized, executor dry-run + failed margin order, strategy SHORT/COVER + stop-loss cover, backtest profitable short) — done
## Touched   — .context/implementation-plan.md — P3-3 marked DONE, P3-4 marked PENDING — done
## Decisions — MARGIN_ENABLED defaults false; shorts are risk-gated identically to buys except the RSI gate is a floor; only ONE position (long or short) per symbol at a time (risk blocks BUY while a short is open and SHORT while a spot position is open)
## Decisions — short exits mirror longs with inverted direction: stop-loss when price RISES, take-profit when price FALLS, trailing tracks the trough; realized short pnl = (entry-price)*amount credited back to the quote wallet so equity reflects it
## Decisions — margin client endpoints (/v2/margin...) follow the documented Nobitex margin contract; unverifiable live but fully mocked in tests and DRY_RUN by default; live margin calls only when MARGIN_ENABLED and not dry-run
## Verified  — 118/118 tests pass (108 + 10 margin); typecheck + build clean
## Open      — P3-4 market making / arbitrage is the last stretch item (highest complexity); ask user whether to proceed or stop here
## Next      — commit P3-3 (feat(margin): short selling) + push; then decide on P3-4 with the user
