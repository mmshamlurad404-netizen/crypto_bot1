import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { HybridStrategy } from "../src/strategy/hybrid.js";

const symbols = [
  { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" },
  { src: "eth", dst: "rls", key: "eth/rls", market: "ETH-RLS" },
];

function setup() {
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
  });
  const strategy = new HybridStrategy(db, feed, sentiment, portfolio, risk, {
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiEntryUpper: 35,
    sentimentEntryThreshold: 0.3,
    sentimentExitThreshold: -0.2,
  });
  return { db, feed, portfolio, risk, sentiment, strategy };
}

function pushCloses(feed: PriceFeed, prices: number[]) {
  let ts = Date.now() - prices.length * 1000;
  for (const p of prices) {
    feed.pushPrice("btc/rls", p, ts);
    ts += 1000;
  }
}

test("warms up until enough samples", () => {
  const { feed, strategy } = setup();
  pushCloses(feed, [100, 101, 102]);
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /warming up/i);
});

test("buys on oversold dip with bullish sentiment", () => {
  const { feed, sentiment, strategy } = setup();
  const prices = Array.from({ length: 40 }, (_, i) => 200 - i);
  pushCloses(feed, prices);
  sentiment.ingest({ account: "verified-acct", symbol: "btc", sentiment: 0.8, confidence: 1 });
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY");
  assert.ok((decision.rsi ?? 100) < 35, `expected low RSI, got ${decision.rsi}`);
  assert.equal(decision.symbol, "btc/rls");
});

test("holds when sentiment is neutral even if RSI is low", () => {
  const { feed, strategy } = setup();
  const prices = Array.from({ length: 40 }, (_, i) => 200 - i);
  pushCloses(feed, prices);
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
});

test("holds when RSI not in dip zone even if sentiment bullish", () => {
  const { feed, sentiment, strategy } = setup();
  pushCloses(feed, Array.from({ length: 40 }, (_, i) => 100 + i));
  sentiment.ingest({ account: "verified-acct", symbol: "btc", sentiment: 0.8, confidence: 1 });
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /RSI/i);
});

test("sells on overbought RSI while holding", () => {
  const { db, feed, sentiment, strategy } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  pushCloses(feed, Array.from({ length: 40 }, (_, i) => 100 + i * 2));
  sentiment.ingest({ account: "verified-acct", symbol: "btc", sentiment: 0.5, confidence: 1 });
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "SELL");
  assert.ok((decision.rsi ?? 0) >= 70, `expected high RSI, got ${decision.rsi}`);
});

test("sells when sentiment turns negative while holding", () => {
  const { db, feed, sentiment, strategy } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  pushCloses(feed, Array.from({ length: 40 }, () => 100));
  sentiment.ingest({ account: "verified-acct", symbol: "btc", sentiment: -0.9, confidence: 1 });
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "SELL");
  assert.match(decision.reason!, /sentiment/i);
});

test("sells on stop-loss trigger", () => {
  const { db, feed, sentiment, strategy } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  pushCloses(feed, Array.from({ length: 40 }, (_, i) => 100 - i));
  sentiment.ingest({ account: "verified-acct", symbol: "btc", sentiment: 0.5, confidence: 1 });
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "SELL");
  assert.match(decision.reason!, /stop-loss/i);
});
