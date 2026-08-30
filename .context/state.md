# State — 2026-08-30

## Intent    — implement P3-2 AI strategy advisor (Phase 3, all stretch items requested step by step) and keep `.context/` updated at each step
## Touched   — src/strategy/ai.ts — created: AiAdvisorStrategy (async evaluate → SignalDecision), HttpLlmClient (OpenAI-compatible /chat/completions), parseAdvice (first JSON object, confidence clamped, action validated) — done
## Touched   — src/config/pools.ts — StrategySpec {kind:"hybrid"|"ai"|"dsl"}; StrategyLike.evaluate returns SignalDecision|Promise<SignalDecision>; StrategyPoolDeps.ai: AiAdvisorConfig|null; buildStrategyPool builds one shared aiStrategy (hybrid fallback); parseSpec accepts "ai" — done
## Touched   — src/config.ts — USER_LLM_API_KEY/BASE_URL/MODEL + AI_ADVISOR_MIN_INTERVAL_SECONDS/CONTEXT_BARS; validation rejects "ai" in pools without a key — done
## Touched   — src/backtest/engine.ts — runBacktest is now async (await strategy.evaluate), ai:null (no LLM in backtest); run.ts + backtest.test.ts await it — done
## Touched   — .env.example + README.md — AI-advisor block + "AI advisor" section — done
## Touched   — tests/ai.test.ts — created: 9 tests (parseAdvice valid/invalid, BUY approved/risk-blocked/position-open, SELL with/without position, HOLD, throttle, warmup+LLM error, pools+config validation) — done
## Touched   — .context/implementation-plan.md — P3-2 marked DONE, P3-3/4 marked PENDING — done
## Decisions — AI advisor is OFF unless a symbol is "ai" in STRATEGY_POOLS AND USER_LLM_API_KEY is set; the key is supplied by the user, never read from the environment or bundled (no-read-llm-env rule)
## Decisions — AI BUY bypasses only the hybrid RSI ceiling (skipRsiGate); cooldown/halt/volatility/exposure/trade-cap/min-value still enforced; errors/throttle/holds all degrade to HOLD
## Decisions — backtester never calls an LLM (ai:null); StrategyLike.evaluate is promise-capable, so runBacktest became async
## Verified  — 108/108 tests pass; typecheck + build clean
## Open      — P3-3 short selling via margin API next (default OFF, heavy testing), then P3-4 market making / arbitrage
## Next      — commit P3-2 (feat(strategy): AI advisor) + push; then P3-3
