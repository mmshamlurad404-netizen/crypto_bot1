import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { parseDsl, evaluateNode, DslStrategy, ConditionNode } from "../src/strategy/dsl.js";
import { parseStrategyPools, buildStrategyPool } from "../src/config/pools.js";
import { loadConfig } from "../src/config.js";

const symbols = [
  { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" },
  { src: "eth", dst: "rls", key: "eth/rls", market: "ETH-RLS" },
];

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

test("parseDsl accepts a valid rule tree and rejects unknown nodes", () => {
  const dsl = parseDsl({ entry: { and: [{ sentiment_gt: 0.3 }, { rsi_lt: 35 }] }, exit: { not: { rsi_gt: 70 } } });
  assert.ok(dsl.entry);
  assert.ok(dsl.exit);
  assert.throws(() => parseDsl({ entry: { bogus: 1 } }));
});

test("evaluateNode combines rsi/sentiment/and/not", () => {
  const ctx = { price: 100, rsi: 20, volatility: 0.01, sentiment: 0.8, closes: [] };
  assert.equal(evaluateNode({ rsi_lt: 25 }, ctx), true);
  assert.equal(evaluateNode({ rsi_gt: 25 }, ctx), false);
  assert.equal(evaluateNode({ sentiment_gt: 0.5 }, ctx), true);
  assert.equal(evaluateNode({ and: [{ rsi_lt: 25 }, { sentiment_gt: 0.5 }] }, ctx), true);
  assert.equal(evaluateNode({ and: [{ rsi_lt: 25 }, { sentiment_gt: 0.9 }] }, ctx), false);
  assert.equal(evaluateNode({ or: [{ rsi_gt: 25 }, { sentiment_gt: 0.5 }] }, ctx), true);
  assert.equal(evaluateNode({ or: [{ rsi_gt: 25 }, { sentiment_gt: 0.9 }] }, ctx), false);
  assert.equal(evaluateNode({ not: { rsi_lt: 25 } }, ctx), false);
});

test("evaluateNode compares price against SMA/EMA", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const rising = { price: 129, rsi: null, volatility: null, sentiment: 0, closes };
  assert.equal(evaluateNode({ price_gt_ma: { kind: "sma", period: 10 } }, rising), true, "price above SMA on a rising series");
  const low = { price: 1, rsi: null, volatility: null, sentiment: 0, closes };
  assert.equal(evaluateNode({ price_gt_ma: { kind: "sma", period: 10 } }, low), false);
  assert.equal(evaluateNode({ price_lt_ma: { kind: "ema", period: 10 } }, low), true);
});

test("null indicators fail numeric conditions", () => {
  const ctx = { price: null, rsi: null, volatility: null, sentiment: null, closes: [100] };
  assert.equal(evaluateNode({ rsi_lt: 50 }, ctx), false);
  assert.equal(evaluateNode({ price_gt_ma: { kind: "sma", period: 2 } }, ctx), false, "null price cannot be above an MA");
});

test("dsl strategy warms up before enough samples", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { sentiment_gt: 0.1 } }));
  pushCloses(feed, "btc/rls", [100, 101, 102]);
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /warming up/i);
});

test("dsl strategy buys when the entry rule is met", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { and: [{ sentiment_gt: 0.3 }, { rsi_lt: 35 }] } }));
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 200 - i));
  sentiment.ingest({ account: "acct", symbol: "btc", sentiment: 0.8, confidence: 1 });
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY");
  assert.match(decision.reason!, /entry/);
});

test("dsl strategy holds when the entry rule is not met", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { sentiment_gt: 0.9 } }));
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 200 - i));
  sentiment.ingest({ account: "acct", symbol: "btc", sentiment: 0.5, confidence: 1 });
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /not met/);
});

test("dsl strategy sells when the exit rule is met while holding", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ exit: { rsi_gt: 70 } }));
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  pushCloses(feed, "btc/rls", [...Array.from({ length: 40 }, () => 100), 105]);
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "SELL");
  assert.match(decision.reason!, /exit/);
});

test("dsl strategy buys on price above SMA even with high RSI (skips hybrid RSI ceiling)", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { price_gt_ma: { kind: "sma", period: 10 } } }));
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 100 + i));
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY", "high RSI on a rising trend must not block a DSL trend entry");
});

test("dsl strategy with no entry rule never buys", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({}));
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, (_, i) => 200 - i));
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /no dsl entry rule/);
});

test("parseStrategyPools accepts hybrid strings and DSL objects", () => {
  const pools = parseStrategyPools('{"btc/rls":"hybrid","eth/rls":{"entry":{"sentiment_gt":0.2}}}');
  assert.equal(pools["btc/rls"]!.kind, "hybrid");
  assert.equal(pools["eth/rls"]!.kind, "dsl");
  assert.throws(() => parseStrategyPools('{"btc/rls":"bogus"}'), /must be "hybrid", "ai", "mm", "arb" or a DSL/);
  assert.throws(() => parseStrategyPools("[1,2]"), /JSON object mapping symbol/);
  assert.throws(() => parseStrategyPools("nope"), /STRATEGY_POOLS must be a JSON object/);
});

test("buildStrategyPool assigns DSL strategies per symbol and hybrid otherwise", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const pool = buildStrategyPool({
    pool: { "eth/rls": { kind: "dsl", dsl: parseDsl({ entry: { sentiment_gt: 0.2 } }) } },
    symbols,
    db,
    priceFeed: feed,
    sentiment,
    portfolio,
    risk,
    strategyConfig: { rsiPeriod: 14, rsiOverbought: 70, rsiEntryUpper: 35, sentimentEntryThreshold: 0.3, sentimentExitThreshold: -0.2 },
    dca: undefined as never,
  });
  pushCloses(feed, "btc/rls", Array.from({ length: 40 }, () => 100));
  pushCloses(feed, "eth/rls", Array.from({ length: 40 }, () => 100));
  sentiment.ingest({ account: "acct", symbol: "eth", sentiment: 0.5, confidence: 1 });
  sentiment.ingest({ account: "acct", symbol: "btc", sentiment: 0.5, confidence: 1 });
  const btc = pool.get("btc/rls")!.evaluate(symbols[0]!);
  const eth = pool.get("eth/rls")!.evaluate(symbols[1]!);
  assert.equal(btc.action, "HOLD", "hybrid still needs an RSI dip, flat series has RSI 100");
  assert.equal(eth.action, "BUY", "dsl sentiment-only entry fires");
});

test("config rejects STRATEGY_POOLS referencing a symbol not in SYMBOLS", () => {
  assert.throws(
    () => loadConfig({ SYMBOLS: "btc/rls", STRATEGY_POOLS: '{"ltc/usdt":"hybrid"}' }),
    /not in SYMBOLS/
  );
});

test("advanced indicator nodes evaluate against provided context", () => {
  const ctx = {
    price: 100,
    rsi: 40,
    volatility: 0.01,
    sentiment: 0,
    closes: [],
    macdHistPct: 0.5,
    stochK: 80,
    stochD: 20,
    atrPct: 2.5,
    bollPct: 5,
  };
  assert.equal(evaluateNode({ macd_hist_pct_gt: 0.4 }, ctx), true);
  assert.equal(evaluateNode({ macd_hist_pct_gt: 0.6 }, ctx), false);
  assert.equal(evaluateNode({ macd_hist_pct_lt: 0.6 }, ctx), true);
  assert.equal(evaluateNode({ stoch_k_gt: 70 }, ctx), true);
  assert.equal(evaluateNode({ stoch_k_lt: 70 }, ctx), false);
  assert.equal(evaluateNode({ stoch_d_lt: 30 }, ctx), true);
  assert.equal(evaluateNode({ atr_pct_gt: 2 }, ctx), true);
  assert.equal(evaluateNode({ atr_pct_lt: 2 }, ctx), false);
  assert.equal(evaluateNode({ boll_pct_gt: 4 }, ctx), true, "price 5% above the mid band exceeds a +4% filter");
  assert.equal(evaluateNode({ boll_pct_lt: -1 }, ctx), false, "price above the mid band is not below the band");
});

test("advanced nodes return false when the indicator context is missing/null", () => {
  const ctx = { price: 100, rsi: null, volatility: null, sentiment: null, closes: [] };
  assert.equal(evaluateNode({ macd_hist_pct_gt: 0 }, ctx), false);
  assert.equal(evaluateNode({ stoch_d_lt: 30 }, ctx), false);
  assert.equal(evaluateNode({ atr_pct_gt: 1 }, ctx), false);
  assert.equal(evaluateNode({ boll_pct_lt: 0 }, ctx), false);
});

test("advanced dsl requires a longer warmup before indicators are valid", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { macd_hist_pct_gt: 0 } }));
  pushCloses(feed, "btc/rls", Array.from({ length: 20 }, (_, i) => 100 + i));
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.match(decision.reason!, /warming up/);
});

test("dsl buys when MACD histogram turns positive on accelerating growth", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { macd_hist_pct_gt: 0 } }));
  pushCloses(feed, "btc/rls", Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.005, i)));
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY", "positive MACD histogram on an uptrend should satisfy the entry rule");
});

test("dsl buys when price trends far above the upper bollinger band", () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  const dsl = new DslStrategy(db, feed, sentiment, portfolio, risk, 14, parseDsl({ entry: { boll_pct_gt: 3 } }));
  pushCloses(feed, "btc/rls", Array.from({ length: 60 }, (_, i) => 100 + i * 0.67));
  const decision = dsl.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY", "a strong steady uptrend must push price far above the 20-bar mid band");
});
