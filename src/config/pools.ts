import { AuditDb } from "../db.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { SymbolPair, SignalDecision } from "../types.js";
import { HybridStrategy, StrategyConfigShape } from "../strategy/hybrid.js";
import { DslJson, parseDsl, DslStrategy } from "../strategy/dsl.js";
import { DcaLadder } from "../strategy/dca.js";

export type StrategySpec = { kind: "hybrid" } | { kind: "dsl"; dsl: DslJson };

export interface StrategyLike {
  evaluate(pair: SymbolPair): SignalDecision;
}

function parseSpec(value: unknown, key: string): StrategySpec {
  if (value === "hybrid") return { kind: "hybrid" };
  if (value !== null && typeof value === "object") {
    try {
      return { kind: "dsl", dsl: parseDsl(value) };
    } catch (err) {
      throw new Error(`STRATEGY_POOLS["${key}"] is not a valid DSL strategy: ${(err as Error).message}`);
    }
  }
  throw new Error(`STRATEGY_POOLS["${key}"] must be "hybrid" or a DSL strategy object`);
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
}

export function buildStrategyPool(args: StrategyPoolDeps): Map<string, StrategyLike> {
  const { pool, symbols, db, priceFeed, sentiment, portfolio, risk, strategyConfig, dca } = args;
  const hybrid = new HybridStrategy(db, priceFeed, sentiment, portfolio, risk, strategyConfig, dca);
  const map = new Map<string, StrategyLike>();
  for (const pair of symbols) {
    const spec = pool[pair.key];
    if (!spec || spec.kind === "hybrid") {
      map.set(pair.key, hybrid);
    } else {
      map.set(pair.key, new DslStrategy(db, priceFeed, sentiment, portfolio, risk, strategyConfig.rsiPeriod, spec.dsl, dca));
    }
  }
  return map;
}
