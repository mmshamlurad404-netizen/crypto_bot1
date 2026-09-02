import { AuditDb } from "../db.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { SymbolPair, SignalDecision } from "../types.js";
import { HybridStrategy, MarginStrategyConfig, StrategyConfigShape } from "../strategy/hybrid.js";
import { DslJson, parseDsl, DslStrategy } from "../strategy/dsl.js";
import { AiAdvisorConfig, AiAdvisorStrategy, HttpLlmClient } from "../strategy/ai.js";
import { DcaLadder } from "../strategy/dca.js";
import { MmStrategyConfig, MarketMakingStrategy } from "../strategy/mm.js";
import { ArbStrategyConfig, ArbitrageStrategy } from "../strategy/arb.js";
import { OrderGateway } from "../execution/gateway.js";
import { NobitexClient } from "../exchange/nobitex.js";
import { ArbExchangeClient } from "../exchange/arb.js";

export type StrategySpec = { kind: "hybrid" } | { kind: "ai" } | { kind: "mm" } | { kind: "arb" } | { kind: "dsl"; dsl: DslJson };

export interface StrategyLike {
  evaluate(pair: SymbolPair): SignalDecision | Promise<SignalDecision>;
  manage?(pair: SymbolPair): Promise<void> | void;
}

function parseSpec(value: unknown, key: string): StrategySpec {
  if (value === "hybrid") return { kind: "hybrid" };
  if (value === "ai") return { kind: "ai" };
  if (value === "mm") return { kind: "mm" };
  if (value === "arb") return { kind: "arb" };
  if (value !== null && typeof value === "object") {
    try {
      return { kind: "dsl", dsl: parseDsl(value) };
    } catch (err) {
      throw new Error(`STRATEGY_POOLS["${key}"] is not a valid DSL strategy: ${(err as Error).message}`);
    }
  }
  throw new Error(`STRATEGY_POOLS["${key}"] must be "hybrid", "ai", "mm", "arb" or a DSL strategy object`);
}

export function parseStrategyPools(raw: string): Record<string, StrategySpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STRATEGY_POOLS must be a JSON object mapping symbol -> strategy, e.g. {\"btc/rls\":\"hybrid\",\"eth/rls\":{...}}");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("STRATEGY_POOLS must be a JSON object mapping symbol -> strategy");
  }
  const result: Record<string, StrategySpec> = {};
  for (const [symbol, spec] of Object.entries(parsed as Record<string, unknown>)) {
    result[symbol] = parseSpec(spec, symbol);
  }
  return result;
}

export interface StrategyPoolDeps {
  pool: Record<string, StrategySpec>;
  symbols: SymbolPair[];
  db: AuditDb;
  priceFeed: PriceFeed;
  sentiment: SentimentEngine;
  portfolio: PortfolioManager;
  risk: RiskManager;
  strategyConfig: StrategyConfigShape;
  dca: DcaLadder;
  ai: AiAdvisorConfig | null;
  margin?: MarginStrategyConfig | null;
  gateway?: OrderGateway | null;
  mm?: MmStrategyConfig | null;
  arb?: ArbStrategyConfig | null;
  arbClient?: ArbExchangeClient | null;
  nobitexClient?: NobitexClient | null;
  tradingActive?: boolean;
  dryRun?: boolean;
  feePct?: number;
}

export function buildStrategyPool(args: StrategyPoolDeps): Map<string, StrategyLike> {
  const { pool, symbols, db, priceFeed, sentiment, portfolio, risk, strategyConfig, dca, ai, margin, gateway, mm, arb, arbClient, nobitexClient, tradingActive, dryRun, feePct } = args;
  const hybrid = new HybridStrategy(db, priceFeed, sentiment, portfolio, risk, strategyConfig, dca, margin ?? null);
  const aiStrategy = ai
    ? new AiAdvisorStrategy(db, priceFeed, sentiment, portfolio, risk, strategyConfig, new HttpLlmClient(ai.baseUrl, ai.apiKey, ai.model), {
        contextBars: ai.contextBars,
        minIntervalMs: ai.minIntervalMs,
      })
    : null;
  const mmStrategy =
    gateway && mm
      ? new MarketMakingStrategy(gateway, db, mm, { tradingActive: tradingActive ?? true, halted: () => risk.isHalted() })
      : null;
  const arbStrategy =
    gateway && arb && arbClient && nobitexClient
      ? new ArbitrageStrategy(gateway, nobitexClient, portfolio, risk, arbClient, db, arb, {
          tradingActive: tradingActive ?? true,
          dryRun: dryRun ?? true,
          feePct: feePct ?? 0,
          halted: () => risk.isHalted(),
        })
      : null;
  const map = new Map<string, StrategyLike>();
  for (const pair of symbols) {
    const spec = pool[pair.key];
    if (!spec || spec.kind === "hybrid") {
      map.set(pair.key, hybrid);
    } else if (spec.kind === "ai") {
      map.set(pair.key, aiStrategy ?? hybrid);
    } else if (spec.kind === "mm") {
      map.set(pair.key, mmStrategy ?? hybrid);
    } else if (spec.kind === "arb") {
      map.set(pair.key, arbStrategy ?? hybrid);
    } else {
      map.set(pair.key, new DslStrategy(db, priceFeed, sentiment, portfolio, risk, strategyConfig.rsiPeriod, spec.dsl, dca));
    }
  }
  return map;
}
