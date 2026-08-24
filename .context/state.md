# State — 2026-08-23

## Intent    — implement P1-3 trailing stop-loss / trailing take-profit (Cryptohopper parity, Phase 1) and keep `.context/` updated at each step
## Touched   — src/config.ts — added TRAILING_STOP_PCT / TRAILING_STOP_ACTIVATE_PCT / TRAILING_TP_PCT / TRAILING_TP_ACTIVATE_PCT (Zod, trailing stop/TP default 0 = disabled) — done
## Touched   — src/risk/manager.ts — added RiskConfigShape fields, TrailingState map (positionId/peak/stopArmed/tpArmed), TrailingCheck result, checkTrailingStops — done
## Touched   — src/strategy/hybrid.ts — trailing checks run after stop-loss, before fixed TP; fixed TP skipped while trailing TP armed — done
## Touched   — src/index.ts — RiskManager wiring of the 4 new config fields — done
## Touched   — src/backtest/engine.ts — RiskConfigShape literal extended with the 4 fields — done
## Touched   — .env.example — documented trailing section (activation, ratchet, supersede note) — done
## Touched   — tests/risk.test.ts — config literal extended + 5 trailing tests (no-hit before activation, arm+ratchet, TP pullback, supersede fixed TP, reset on close/re-entry) — done
## Touched   — .context/implementation-plan.md — P1-3 marked DONE — done
## Decisions — trailing stop/TP default to 0 (off); when off, existing fixed SL/TP behavior is unchanged
## Decisions — armed trailing TP supersedes fixed TP in HybridStrategy; keep TRAILING_TP_ACTIVATE_PCT <= TAKE_PROFIT_PCT for it to take effect
## Decisions — fixed stop-loss stays as the unconditional floor; trailing stop only triggers once armed above entry
## Decisions — trailing state is in-memory keyed by positionId; resets on close or when the open position changes
## Verified  — 44/44 tests pass (39 + 5 new); typecheck + build clean; committed d3ea5e8 + pushed to origin/master
## Open      — trailing behavior only validated in unit tests so far; backtest replay with trailing on a real history pull would be a good sanity check (optional)
## Next      — P1-4 DCA (averaging down) or user's choice
