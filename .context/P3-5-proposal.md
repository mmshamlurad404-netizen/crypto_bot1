# P3-5 Proposal — what to build next

Updated: 2026-09-04
Basis: `.context/gap-analysis.md` (rows still PARTIAL/GAP after P1–P3.4) + the documented
"gotchas" in `.context/map.md` that are now the only real-money risks left. Phase 3 (stretch)
is complete; this opens a new stretch phase.

## Remaining implementable gap-analysis rows
| Row | Feature | Status today | Real value left |
|-----|---------|--------------|-----------------|
| 23 | Paper/backtest ↔ live sync (reconciliation) | PARTIAL — wallets refresh each tick | High: live fills that land between polls / during downtime can silently drift the audit DB |
| 13 | Indicator library + candle patterns | PARTIAL — RSI, volatility, SMA/EMA only | Medium: richer DSL/AI/trigger inputs |
| 2  | Portfolio/trading terminal UI | PARTIAL — audit DB only, no dashboard | Medium: observability, no trading UI needed |
| 24 | Notifications | PARTIAL — Telegram only | Low |
| 28 | Taxes & reporting export | PARTIAL — CSV trades/positions only | Low |

Plus the following in-memory state that resets on restart (documented in map.md and risk/margin
code), which becomes dangerous the moment MM/arb/margin go live:

- `RiskManager` halt state (in-memory; a daily-loss halt disappears on restart → next boot can
  trade again).
- Trailing stop/TP ratchets (per-position peak + armed flags are in-memory; a restart drops a
  position back to the fixed stop).
- MM per-pair inventory/cost-basis (in-memory; after a restart with resting live orders out, the
  strategy would re-quote from zero inventory and can overshoot).
- Resting live limit orders are only tracked inside `orders`; a fill that happened while the
  process was down is never booked (Executor never re-polls stale "new" orders at boot).

## Proposal A — Live hardening & recovery (recommended)
Close the restart/reconciliation gap so every P3 feature (margin, MM, arb, hybrid) is safe in
live mode. Scope:

1. **Persist risk + trailing state**: store the daily-loss halt (reason/ts) and per-position
   trailing peak/armed flags in `meta` on every mutation; rehydrate at startup from open
   positions. Restart no longer clears a halt or resets trailing stops.
2. **Boot-time order recovery**: on startup, for every DB order still `status=new` (live), poll
   the exchange (orderStatus by `nobitexOrderId`, `clientOrderId` fallback — already built) and
   book any fills that happened while down; cancel or leave stale quotes per MM age policy.
3. **MM state rehydration**: derive inventory/cost-basis at boot from open positions instead of
   starting at zero; only then start quoting.
4. **Periodic reconciliation**: a `--check`/report mode (and an optional per-day reconcile) that
   compares DB open positions + open orders vs exchange wallet balances and open orders, logging
   and alerting drift instead of silently diverging.
5. Tests: restart simulation for each of the four scenarios + a reconcile drift report.

Value: removes the remaining "state lost on restart" hazards; effort medium; every existing test
stays green. This is the natural safety-first capstone for a live-capable bot.

## Proposal B — Indicator library + DSL nodes (feature breadth)
Add MACD, Bollinger Bands, ATR, stochastic, ADX to `src/indicators.ts`; expose them as DSL
condition nodes (`macd_cross_above`, `price_gt_boll_upper`, `atr_lt`, `stoch_lt`, …), new
trigger conditions, and extra context in the AI snapshot. Value: strategy-designer parity
(gap row 12), self-contained, heavily unit-testable. Effort medium-high. Does not reduce live risk.

## Proposal C — Read-only operations dashboard
Serve server-rendered HTML/JSON from the existing webhook server (`/dashboard`): live equity,
open positions + orders, recent signals/risk events, today's PnL and 30-day metrics, plus CSV
download reuse. No frontend build (no Vite/CRA proxy needed), so it stays one-port and low
effort. Value: observability for a headless bot. Does not reduce live risk.

## Recommendation
Do **A first** (it de-risks every live feature including the ones shipped in P3-4 and is the
cheapest insurance), then B or C in a later stretch phase if wanted. Items 24/28 stay low-priority.

Decision to confirm with the owner: single scope A, or A+B, or A+C, or a different option.
