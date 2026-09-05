# State — 2026-09-05

## Intent    — ship P3-5 A+B: live hardening & recovery (persisted risk/trailing/MM state, boot-time order recovery, reconciliation) + MACD/Bollinger/ATR-proxy/stochastic indicators exposed through DSL, triggers, and AI context
## Touched   — src/risk/manager.ts — PersistedRiskState under meta risk.state_v1 via new AuditDb.getMetaJSON/setMetaJSON; halt reason/ts, per-pair cooldowns, trailing stop/TP ratchets, margin trailing state persist on mutation; restore() rehydrates; daily-loss halts clear only on a new UTC day (halt-cleared), trigger halts restore as-is (halt-restored) — done
## Touched   — src/execution/executor.ts — recoverLiveOrders(): boot sweep of every order still `new`, polls each exactly once, books down-time fills, marks canceled/failed, skips dryRun/live mode-mismatched rows -> RecoveryReport — done
## Touched   — src/strategy/mm.ts — persist() per-pair meta mm.state.<pairKey> (costBasis/lastFillAt); restore() re-adopts inventory from open positions, cost basis from meta (or entry price), resting quote ids/timestamps from db.openOrders (mm_bid/mm_ask); StrategyLike gains optional restore?() — done
## Touched   — src/index.ts — startBot runs executor.recoverLiveOrders() + per-strategy restore?.() in an async boot() before the first tick(); rich indicators computed per tick only when configured triggers need them — done
## Touched   — src/reconcile.ts + package.json — deriveSpotExpectation (open positions − amount resting in open sells per base) vs PortfolioManager.getHoldings(); formatReport; `npm run reconcile` exits 1 on drift; skips DRY_RUN bots — done
## Touched   — src/indicators.ts — emaSeries, calculateMACD (12/26/9), calculateBollinger (20/2), calculateStoch (14/3), calculateCloseRangePct (ATR proxy), computeRichIndicators (macdHistPct, atrPct, stochK/stochD, bollinger bands) — done
## Touched   — src/strategy/dsl.ts — nodes macd_hist_pct_lt/gt, stoch_k_lt/gt, stoch_d_lt/gt, atr_pct_lt/gt, boll_pct_lt/gt; warmup ≥45 with advanced nodes; hasAdvancedNodes picks rich vs base path — done
## Touched   — src/triggers/engine.ts + src/config.ts — conditions volatility_above/below, atr_pct_*, stoch_k_*, stoch_d_*, macd_hist_pct_*; volatility added to TriggerInput; currentValue/conditionMet handle all; zod trigger enum updated — done
## Touched   — src/strategy/ai.ts — LLM snapshot includes macdHistPct, atrPct, stochK/stochD, bollinger{upper,middle,lower} — done
## Touched   — tests — recovery.test.ts (7), indicators.test.ts (7), dsl.test.ts +6, triggers.test.ts +4, ai.test.ts snapshot; suite 158/158, typecheck + build clean — done
## Touched   — .env.example + README.md — trigger condition table, DSL node table, AI snapshot, restart-safety & reconciliation sections, reconcile script doc — done
## Touched   — .context/implementation-plan.md (P3-5 DONE) + .context/map.md (new modules/methods/gotchas) — done
## Decisions — a restart no longer clears a trigger halt or resets trailing ratchets; only a new UTC day clears a persisted daily-loss halt
## Decisions — boot recovery runs before the first tick; dry-run/live mode-mismatched resting orders are skipped, never sent to the exchange
## Decisions — indicators compute deterministically on the stored close-only series; true OHLC ATR/stoch would need high/low the bot doesn't retain, so close-range/close-based proxies are used and documented as such; history gaps return null (warmup preserved), never crash
## Decisions — persisted state lives in the meta table as versioned JSON single-row blobs (risk.state_v1, mm.state.<pairKey>); setMetaJSON writes are best-effort so a meta failure never takes a tick down; DB schema stays stable
