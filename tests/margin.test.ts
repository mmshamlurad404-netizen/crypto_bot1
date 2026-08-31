import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { Executor } from "../src/execution/executor.js";
import { HybridStrategy, MarginStrategyConfig } from "../src/strategy/hybrid.js";
import { createLogger } from "../src/logger.js";
import { runBacktest } from "../src/backtest/engine.js";
import { BacktestBar } from "../src/backtest/data.js";
import { SentimentInput, SymbolPair } from "../src/types.js";

const pair: SymbolPair = { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" };
const symbols = [pair];
const logger = createLogger("warn");

const riskBase = {
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
  rsiShortEntryFloor: 65,
  marginStopLossPct: 3,
  marginTakeProfitPct: 6,
};

function baseSetup() {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  const sentiment = new SentimentEngine(db, 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 0.1);
  const portfolio = new PortfolioManager(db, client, feed, symbols, "rls", true, 100_000_000);
  portfolio.refresh().catch(() => undefined);
  const risk = new RiskManager(db, feed, portfolio, riskBase);
  return { db, client, feed, portfolio, risk, sentiment };
}

async function seedBestPrices(feed: PriceFeed, client: NobitexClient, ask: number, bid: number) {
  (client as unknown as { marketStats: () => Promise<Record<string, { isClosed: boolean; bestSell: string; bestBuy: string }>> }).marketStats = async () => ({
    "btc-rls": { isClosed: false, bestSell: String(ask), bestBuy: String(bid) },
  });
  await feed.poll();
}

function pushCloses(feed: PriceFeed, prices: number[]) {
  let ts = Date.now() - prices.length * 1000;
  for (const p of prices) {
    feed.pushPrice(pair.key, p, ts);
    ts += 1000;
  }
}

const strategyConfig = { rsiPeriod: 14, rsiOverbought: 70, rsiEntryUpper: 35, sentimentEntryThreshold: 0.3, sentimentExitThreshold: -0.2 };

function marginConfig(overrides: Partial<MarginStrategyConfig> = {}): MarginStrategyConfig {
  return { enabled: true, leverage: 2, maxShortPct: 10, symbols: [], ...overrides };
}

test("config: margin is OFF by default and parses when enabled", () => {
  const off = loadConfig({ SYMBOLS: "btc/rls" });
  assert.equal(off.margin.enabled, false);
  assert.equal(off.margin.leverage, 2);
  assert.equal(off.rsiShortEntryFloor, 65);
  const on = loadConfig({
    SYMBOLS: "btc/rls",
    MARGIN_ENABLED: "true",
    MARGIN_LEVERAGE: "3",
    MARGIN_MAX_SHORT_PCT: "5",
    MARGIN_SYMBOLS: "btc/rls",
    MARGIN_STOP_LOSS_PCT: "4",
    MARGIN_TAKE_PROFIT_PCT: "8",
  });
  assert.equal(on.margin.enabled, true);
  assert.equal(on.margin.leverage, 3);
  assert.equal(on.margin.maxShortPct, 5);
  assert.deepEqual(on.margin.symbols, ["btc/rls"]);
  assert.equal(on.margin.stopLossPct, 4);
  assert.equal(on.margin.takeProfitPct, 8);
  assert.throws(() => loadConfig({ SYMBOLS: "btc/rls", MARGIN_SYMBOLS: "eth/rls" }), /MARGIN_SYMBOLS references symbol "eth\/rls"/);
});

test("risk: evaluateShort gates mirror longs and block open positions", () => {
  const { db, feed, portfolio, risk } = baseSetup();
  pushCloses(feed, Array.from({ length: 40 }, (_, i) => 100 + i));
  const equity = portfolio.equity();
  const orderValue = equity * 0.1;

  assert.equal(risk.evaluateShort(pair, orderValue, 0.01, 75).allowed, true);
  assert.equal(risk.evaluateShort(pair, orderValue, 0.01, 60).allowed, false, "rsi below short floor blocked");
  assert.equal(risk.evaluateShort(pair, orderValue, 0.01, null).allowed, false, "missing rsi blocked");

  db.insertPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: 100, amount: 10, orderId: null });
  assert.equal(risk.evaluateShort(pair, orderValue, 0.01, 75).allowed, false, "spot position blocks a short");
  const spot = db.getOpenPosition(pair.key)!;
  db.closePosition(spot.id, new Date().toISOString(), 101, 10, "sold");

  db.insertMarginPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: 100, amount: 10, leverage: 2, orderId: null });
  assert.equal(risk.evaluateShort(pair, orderValue, 0.01, 75).allowed, false, "open short blocks another short");
  assert.equal(risk.evaluateBuy(pair, orderValue, 0.01, 20).allowed, false, "open short blocks a spot buy");
});

test("risk: margin stop/take-profit trigger in the inverted direction", () => {
  const { db, feed, portfolio, risk } = baseSetup();
  pushCloses(feed, [100, 100, 100]);
  db.insertMarginPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: 100, amount: 10, leverage: 2, orderId: null });

  assert.equal(risk.checkMarginStopLoss(pair, 100).hit, false);
  assert.equal(risk.checkMarginStopLoss(pair, 103.1).hit, true);
  assert.equal(risk.checkMarginStopLoss(pair, 103.1).reason, "margin stop-loss 3%");

  assert.equal(risk.checkMarginTakeProfit(pair, 96).hit, false);
  assert.equal(risk.checkMarginTakeProfit(pair, 93.9).hit, true);
  assert.equal(risk.checkMarginTakeProfit(pair, 93.9).reason, "margin take-profit 6%");
});

test("portfolio: open shorts contribute unrealized pnl and exposure", () => {
  const { db, feed, portfolio } = baseSetup();
  pushCloses(feed, [100, 100, 100]);
  db.insertMarginPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: 100, amount: 10, leverage: 2, orderId: null });
  assert.equal(portfolio.equity(), 100_000_000, "flat short has zero pnl");

  feed.pushPrice(pair.key, 95, Date.now());
  assert.equal(portfolio.equity(), 100_000_050, "falling price profits a short");
  const state = portfolio.state();
  assert.ok(state.marginPositions.length === 1);
  assert.equal(state.marginPositions[0]!.unrealizedPnl, 50);
  assert.equal(state.positionsValue, 950);
});

test("portfolio: applyMarginClose realizes inverted pnl and clears the position", () => {
  const { db, feed, portfolio } = baseSetup();
  pushCloses(feed, [100, 100, 100]);
  db.insertMarginPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: 100, amount: 10, leverage: 2, orderId: null });
  feed.pushPrice(pair.key, 90, Date.now());
  portfolio.applyMarginClose(pair, 10, 90, 0, null);
  assert.equal(db.getOpenMarginPosition(pair.key), null);
  const closed = db.closedMarginPositionsBetween("1970-01-01", "3000-01-01");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.realizedPnl, 100);
});

test("executor: dry-run openShort sells at the bid and coverShort buys at the ask", async () => {
  const { db, client, feed, portfolio, risk, sentiment } = baseSetup();
  pushCloses(feed, [100, 100, 100]);
  await seedBestPrices(feed, client, 100, 100);
  const executor = new Executor(db, client, feed, portfolio, risk, true, 0.25, logger);

  const short = await executor.openShort(pair, 10, 2);
  assert.ok(short);
  assert.equal(short.side, "sell");
  assert.equal(short.price, 100);
  const pos = db.getOpenMarginPosition(pair.key);
  assert.ok(pos);
  assert.equal(pos!.amount, 10);
  assert.equal(pos!.leverage, 2);
  const order = db.getOrder(short.orderId);
  assert.equal(order!.kind, "short_open");

  feed.pushPrice(pair.key, 90, Date.now());
  await seedBestPrices(feed, client, 90, 90);
  const cover = await executor.coverShort(pair, 10);
  assert.ok(cover);
  assert.equal(cover.side, "buy");
  assert.equal(cover.price, 90);
  assert.equal(db.getOpenMarginPosition(pair.key), null);
  const closed = db.closedMarginPositionsBetween("1970-01-01", "3000-01-01");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.realizedPnl, 100);
  assert.equal(db.getOrder(cover.orderId)!.kind, "short_cover");
});

test("executor: failed margin order leaves no position", async () => {
  const { db, client, feed, portfolio, risk } = baseSetup();
  pushCloses(feed, [100, 100, 100]);
  await seedBestPrices(feed, client, 100, 100);
  (client as unknown as { marginAddOrder: () => Promise<{ status: string; code: string }> }).marginAddOrder = async () => ({ status: "failed", code: "InsufficientMargin" });
  const executor = new Executor(db, client, feed, portfolio, risk, false, 0.25, logger);
  const fill = await executor.openShort(pair, 10, 2);
  assert.equal(fill, null);
  assert.equal(db.getOpenMarginPosition(pair.key), null);
});

test("hybrid strategy: SHORT on overbought+bearish only when margin enabled, COVER on reversal", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  sentiment.ingest({ account: "t", symbol: pair.src, sentiment: -0.5, confidence: 1 });

  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  pushCloses(feed, rising);

  const disabled = new HybridStrategy(db, feed, sentiment, portfolio, risk, strategyConfig);
  assert.equal((await disabled.evaluate(pair)).action, "HOLD", "margin disabled -> no short");

  const enabled = new HybridStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, undefined, marginConfig());
  const short = await enabled.evaluate(pair);
  assert.equal(short.action, "SHORT");
  assert.equal(short.sizePct, 10);

  const currentPrice = feed.getLatestPrice(pair.key)!;
  const opened = db.insertMarginPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: currentPrice, amount: 10, leverage: 2, orderId: null });

  const stillBearish = await enabled.evaluate(pair);
  assert.equal(stillBearish.action, "HOLD");
  assert.match(stillBearish.reason!, /holding short/);

  sentiment.ingest({ account: "t", symbol: pair.src, sentiment: 0.8, confidence: 1 });
  sentiment.ingest({ account: "t", symbol: pair.src, sentiment: 0.8, confidence: 1 });
  sentiment.ingest({ account: "t", symbol: pair.src, sentiment: 0.8, confidence: 1 });
  const cover = await enabled.evaluate(pair);
  assert.equal(cover.action, "COVER");
  assert.match(cover.reason!, /turned bullish/);

  db.closeMarginPosition(opened, new Date().toISOString(), 110, -100, "covered");
});

test("hybrid strategy: margin stop-loss triggers a COVER", async () => {
  const { db, feed, portfolio, risk, sentiment } = baseSetup();
  pushCloses(feed, Array.from({ length: 20 }, () => 100));
  const enabled = new HybridStrategy(db, feed, sentiment, portfolio, risk, strategyConfig, undefined, marginConfig());
  db.insertMarginPosition({ symbol: pair.key, openTs: new Date().toISOString(), entryPrice: 100, amount: 10, leverage: 2, orderId: null });
  feed.pushPrice(pair.key, 103.5, Date.now());
  const decision = await enabled.evaluate(pair);
  assert.equal(decision.action, "COVER");
  assert.match(decision.reason!, /margin stop-loss/);
});

test("backtest: profitable short round trip when price falls", async () => {
  const config = loadConfig({
    SYMBOLS: "btc/rls",
    MARGIN_ENABLED: "true",
    MARGIN_MAX_SHORT_PCT: "10",
    MARGIN_LEVERAGE: "2",
    MARGIN_STOP_LOSS_PCT: "100",
    MARGIN_TAKE_PROFIT_PCT: "1",
    RSI_ENTRY_UPPER: "35",
    RSI_OVERBOUGHT: "90",
    SENTIMENT_ENTRY_THRESHOLD: "0.5",
    SENTIMENT_EXIT_THRESHOLD: "-0.5",
    COOLDOWN_MINUTES: "0",
    TRADING_ENABLED: "false",
  });
  const startTs = Date.UTC(2026, 0, 1);
  const rise = Array.from({ length: 70 }, (_, i) => 100 + (i * 100) / 69);
  const fall = Array.from({ length: 30 }, (_, i) => 200 - (i * 100) / 29);
  const bars: BacktestBar[] = [...rise, ...fall].map((close, i) => {
    const ts = startTs + i * 60_000;
    return { ts, open: close, high: close, low: close, close, volume: 1 };
  });
  const sentiment: SentimentInput[] = bars
    .filter((_, i) => i >= 60)
    .map((b) => ({ account: "t", symbol: pair.src, sentiment: -0.8, confidence: 1, timestamp: b.ts }));
  const result = await runBacktest({ config, pair, bars, sentimentEvents: sentiment, startEquity: 100_000_000 });
  assert.ok(result.roundTrips.length >= 1, "expected at least one short round trip");
  assert.ok(result.roundTrips[0]!.realizedPnl > 0, `expected a profit, got ${result.roundTrips[0]!.realizedPnl}`);
  assert.equal(result.metrics.roundTrips, result.roundTrips.length);
  assert.ok(result.metrics.endEquity > result.metrics.startEquity);
});
