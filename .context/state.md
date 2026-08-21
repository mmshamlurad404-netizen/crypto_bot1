# State — 2026-08-21

## Intent    — compare our bot against Cryptohopper, write gap analysis + implementation plan, keep `.context/` updated at each step
## Touched   — .context/map.md — unchanged (shape covers current modules; will update when new modules land) — done
## Touched   — .context/state.md — updated: this checkpoint — done
## Touched   — .context/gap-analysis.md — created: 29-item feature surface vs Cryptohopper, priority ranking, out-of-scope list — done
## Touched   — .context/implementation-plan.md — created: 3 phases (P1 validate/instrument, P2 generalize strategy+signals, P3 stretch) — done
## Decisions — scope: on-prem, Nobitex-only, safety-first; marketplace/social/mobile/multi-exchange explicitly out of scope
## Decisions — priority: backtester + performance analytics + trailing stops first (highest value/lowest risk); DCA and trigger engine next
## Decisions — keep existing hybrid strategy as default compiled strategy so P1 changes don't alter live behavior until user opts in
## Verified  — docs.cryptohopper.com/docs/trading-bot — feature areas: base config (buy/sell), config pools, signals, triggers, DCA, shorting, paper trading, auto-sync, dashboards, stats
## Verified  — docs.cryptohopper.com/docs/my-library — Strategy Builder, Algorithm Intelligence (AI), TradingView Alerts, Backtester, technical indicators, candle patterns
## Verified  — cryptohopper.com homepage — 16+ exchanges, copy trading, market making, arbitrage, bulk bot manager, marketplace, social, mobile, MCP — all GAP except paper trading + core buy/sell automation
## Open      — whether user wants P1 items now, and in which order; backtester vs analytics first
## Next      — await user go-ahead on Phase 1 scope; then implement P1-1 backtester (or user's chosen first item), updating .context/state.md as we go
