import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { AiAdvisorStrategy, LlmAdvice, LlmClient, parseAdvice } from "../src/strategy/ai.js";
import { parseStrategyPools } from "../src/config/pools.js";
import { loadConfig } from "../src/config.js";

const symbols = [{ src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" }];

class FakeLlm implements LlmClient {
  calls: string[] = [];
  advice: LlmAdvice;
  error: Error | null = null;

  constructor(advice: LlmAdvice) {
    this.advice = advice;
  }

  async advise(context: string): Promise<LlmAdvice> {
    this.calls.push(context);
    if (this.error) throw this.error;
    return this.advice;
  }
}

function baseSetup() {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  const sentiment = new SentimentEngine(db, 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 0.1);
  const portfolio = new PortfolioManager(db, client, feed, symbols, "rls", true, 100_000_000);
  portfolio.refresh().catch(() => undefined);
  const risk = new RiskManager(db, feed, portfolio, {
    maxPositionSizePct: 10,
    maxTotalExposurePct: 40,
    maxDailyLossPct: 3,
    maxTradesPerDay: 6,
    minOrderValue: 5_000_000,
    volatilityMax: 0.05,
    volatilityBenchmark: 0.02,
    volatilitySizeCap: 2,
    cooldownMinutes: 0,
    rsiPeriod: 14,
    rsiEntryUpper: 35,
    stopLossPct: 3,
    takeProfitPct: 6,
    trailingStopPct: 0,
    trailingStopActivatePct: 1.5,
    trailingTpPct: 0,
    trailingTpActivatePct: 2,
  });
  return { db, feed, portfolio, risk, sentiment };
}

function pushCloses(feed: PriceFeed, symbol: string, prices: number[]) {
  let ts = Date.now() - prices.length * 1000;
  for (const p of prices) {
    feed.pushPrice(symbol, p, ts);
    ts += 1000;
  }
}

const strategyConfig = { rsiPeriod: 14, rsiOverbought: 70, rsiEntryUpper: 35, sentimentEntryThreshold: 0.3, sentimentExitThreshold: -0.2 };

test("parseAdvice extracts the JSON object and clamps confidence", () => {
  const advice = parseAdvice('```json\n{"action":"BUY","confidence":2,"rationale":"trend up"}\n```');
  assert.deepEqual(advice, { action: "BUY", confidence: 1, rationale: "trend up" });
  assert.throws(() => parseAdvice("no json here"), /no JSON object/);
  assert.throws(() => parseAdvice('{"action":"MOON"}'), /unsupported action/);
  assert.throws(() => parseAdvice('{"action":}'), /not valid JSON/);
});

test("ai advisor buys when the LLM says BUY and risk approves", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const llm = new FakeLlm({ action: "BUY", confidence: 0.9, rationale: "momentum" });
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 0 });
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  const decision = await strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY");
  assert.match(decision.reason!, /ai conf 0.9/);
  assert.equal(decision.sizePct, 10);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0]!, /"rsi"/);
  assert.match(llm.calls[0]!, /"sentimentScore"/);
  assert.match(llm.calls[0]!, /"lastBars"/);
  assert.match(llm.calls[0]!, /"macdHistPct"/);
  assert.match(llm.calls[0]!, /"bollinger"/);
});

test("ai advisor blocks a BUY when risk vetoes (volatility gate)", async () => {
  const { db, feed, portfolio, sentiment } = baseSetup();
  const risk = new RiskManager(
    db,
    feed,
    portfolio,
    {
      maxPositionSizePct: 10,
      maxTotalExposurePct: 40,
      maxDailyLossPct: 3,
      maxTradesPerDay: 6,
      minOrderValue: 5_000_000,
      volatilityMax: 0.0001,
      volatilityBenchmark: 0.02,
      volatilitySizeCap: 2,
      cooldownMinutes: 0,
      rsiPeriod: 14,
      rsiEntryUpper: 35,
      stopLossPct: 3,
      takeProfitPct: 6,
      trailingStopPct: 0,
      trailingStopActivatePct: 1.5,
      trailingTpPct: 0,
      trailingTpActivatePct: 2,
    }
  );
  const llm = new FakeLlm({ action: "BUY", confidence: 0.9, rationale: "momentum" });
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 0 });
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  const decision = await strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /ai buy blocked/);
});

test("ai advisor ignores BUY while a position is open", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const llm = new FakeLlm({ action: "BUY", confidence: 0.9, rationale: "momentum" });
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 0 });
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  const decision = await strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /ai buy ignored/);
});

test("ai advisor sells when the LLM says SELL and a position is open", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const llm = new FakeLlm({ action: "SELL", confidence: 0.8, rationale: "exit" });
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 0 });
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  pushCloses(feed, "btc/rls", [...Array.from({ length: 40 }, () => 100), 105]);
  const decision = await strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "SELL");
  assert.match(decision.reason!, /ai \(exit\)/);
});

test("ai advisor ignores SELL with no open position and holds on HOLD advice", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const llm = new FakeLlm({ action: "SELL", confidence: 0.5, rationale: "exit" });
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 0 });
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  const sell = await strategy.evaluate(symbols[0]!);
  assert.equal(sell.action, "HOLD");
  assert.match(sell.reason!, /ai sell ignored/);

  const llm2 = new FakeLlm({ action: "HOLD", confidence: 0.5, rationale: "stay" });
  const strategy2 = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm2, { minIntervalMs: 0 });
  const hold = await strategy2.evaluate(symbols[0]!);
  assert.equal(hold.action, "HOLD");
  assert.match(hold.reason!, /ai holds/);
});

test("ai advisor throttles calls to the LLM", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const llm = new FakeLlm({ action: "BUY", confidence: 0.5, rationale: "x" });
  let t = 1_000_000;
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 5000, now: () => t });
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  await strategy.evaluate(symbols[0]!);
  assert.equal(llm.calls.length, 1);
  t += 1000;
  const second = await strategy.evaluate(symbols[0]!);
  assert.equal(llm.calls.length, 1, "within the interval the LLM must not be called again");
  assert.match(second.reason!, /ai advisor throttled/);
  t += 5000;
  await strategy.evaluate(symbols[0]!);
  assert.equal(llm.calls.length, 2, "after the interval the LLM is consulted again");
});

test("ai advisor handles LLM failures and the warmup window", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const llm = new FakeLlm({ action: "BUY", confidence: 0.5, rationale: "x" });
  llm.error = new Error("upstream down");
  const strategy = new AiAdvisorStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, llm, { minIntervalMs: 0 });
  pushCloses(feed, "btc/rls", [100, 101, 102]);
  const warm = await strategy.evaluate(symbols[0]!);
  assert.equal(warm.action, "HOLD");
  assert.match(warm.reason!, /warming up/);
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  const failed = await strategy.evaluate(symbols[0]!);
  assert.equal(failed.action, "HOLD");
  assert.match(failed.reason!, /ai advisor error/);
});

test("parseStrategyPools accepts ai and config requires USER_LLM_API_KEY", () => {
  const pools = parseStrategyPools('{"btc/rls":"ai"}');
  assert.equal(pools["btc/rls"]!.kind, "ai");
  assert.throws(() => loadConfig({ SYMBOLS: "btc/rls", STRATEGY_POOLS: '{"btc/rls":"ai"}' }), /USER_LLM_API_KEY is not set/);
  const config = loadConfig({ SYMBOLS: "btc/rls", STRATEGY_POOLS: '{"btc/rls":"ai"}', USER_LLM_API_KEY: "sk-test" });
  assert.ok(config.aiAdvisor);
  assert.equal(config.aiAdvisor!.model, "deepseek-chat");
});
