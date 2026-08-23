# State — 2026-08-22

## Intent    — implement P1-2 Performance analytics + CSV export (Cryptohopper parity, Phase 1) and keep `.context/` updated at each step
## Touched   — src/report/metrics.ts — created: computeMetrics (win rate, profit factor, net PnL, drawdown, Sharpe, exposure, return) over a range — done
## Touched   — src/export/trades.ts — created: CSV export CLI (--kind trades|positions, --from/--to), EPIPE-safe — done
## Touched   — src/alerts/report.ts — DailyReporter now emits a "Performance (last 30d)" section — done
## Touched   — src/db.ts — added closedPositionsBetween + snapshotsBetween + indexes (positions.close_ts, portfolio_snapshots.ts) — done
## Touched   — tests/metrics.test.ts — created: 5 tests (win-rate/PF, drawdown/Sharpe/exposure, fills, empty, ranges) — done
## Touched   — README.md — Performance metrics & CSV export section + architecture tree — done
## Touched   — .context/implementation-plan.md — P1-2 marked DONE — done
## Touched   — .context/map.md — added export/, report/, new db methods, metrics/export gotchas — done
## Decisions — metrics default to last 30 days; drawdown/Sharpe/exposure require portfolio_snapshots; win-rate/PF require closed positions
## Decisions — Sharpe uses day-gap returns from snapshots (≈1/day at report time); annualized ×√365; null when <2 snapshots or zero std
## Decisions — CSV uses integer formatting for large rial values (FP epsilon 1e-4) and up-to-8-decimals for crypto amounts
## Verified  — 39/39 tests pass (34 + 5 new); typecheck + build clean; CSV export smoke-tested on a seeded DB (trades, positions, date ranges)
## Open      — metrics are mark-to-market at snapshot time only (once/day); intraday drawdown is not captured
## Next      — commit + push P1-2; then P1-3 trailing stop-loss / take-profit (or user's choice)
