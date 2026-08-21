import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";

const symbols = [
  { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" },
  { src: "eth", dst: "rls", key: "eth/rls", market: "ETH-RLS" },
];

function setup(overrides: Partial<Record<string, number>> = {}) {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  const portfolio = new PortfolioManager(db, client, feed, symbols, "rls", true, 100_000_000);
  portfolio.refresh().catch(() => undefined);
  feed.pushPrice("btc/rls", 100);
  feed.pushPrice("eth/rls", 100);
  const config = {
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
    ...overrides,
  };
  const risk = new RiskManager(db, feed, portfolio, config);
  return { db, feed, portfolio, risk };
}

test("buy blocked when position size exceeds max", () => {
  const { risk } = setup();
  const verdict = risk.evaluateBuy(symbols[0]!, 20_000_000, 0.01, 30);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /max position size/i);
});

test("buy blocked when volatility exceeds max", () => {
  const { risk } = setup();
  const verdict = risk.evaluateBuy(symbols[0]!, 5_000_000, 0.06, 30);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /volatility/i);
});

test("buy blocked below minimum order value", () => {
  const { risk } = setup();
  const verdict = risk.evaluateBuy(symbols[0]!, 1_000, 0.01, 30);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /minimum/i);
});

test("buy blocked when total exposure limit would be exceeded", () => {
  const { db, feed, portfolio, risk } = setup();
  feed.pushPrice("eth/rls", 100);
  db.insertPosition({ symbol: "eth/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 300_000, orderId: null });
  portfolio.refresh().catch(() => undefined);
  const verdict = risk.evaluateBuy(symbols[0]!, 20_000_000, 0.01, 30);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /exposure/i);
});

test("buy allowed within limits and sizes by volatility", () => {
  const { risk } = setup();
  const verdict = risk.evaluateBuy(symbols[0]!, 5_000_000, 0.02, 30);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.sizePct, 10);
});

test("size scales down when volatility is high", () => {
  const { risk } = setup();
  assert.equal(risk.sizeByVolatility(0.02), 10);
  assert.ok(risk.sizeByVolatility(0.04) < 10, "higher vol => smaller size");
  assert.equal(risk.sizeByVolatility(0.01), 10);
});

test("stop-loss and take-profit trigger at thresholds", () => {
  const { db, risk } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 100, orderId: null });
  const sl = risk.checkStopLoss(symbols[0]!, 96.99);
  assert.equal(sl.hit, true);
  const noSl = risk.checkStopLoss(symbols[0]!, 97.01);
  assert.equal(noSl.hit, false);
  const tp = risk.checkTakeProfit(symbols[0]!, 106.01);
  assert.equal(tp.hit, true);
});

test("trading halts on daily loss limit", () => {
  const { db, feed, portfolio, risk } = setup();
  db.setMeta("prev_day_equity", "100000000");
  portfolio.applyTrade(symbols[1]!, "buy", 300_000, 100, 0, null);
  feed.pushPrice("eth/rls", 60);
  portfolio.refresh().catch(() => undefined);
  const verdict = risk.evaluateBuy(symbols[0]!, 5_000_000, 0.01, 30);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.halted, true);
});

test("open position blocks re-entry", () => {
  const { db, risk } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 100, orderId: null });
  const verdict = risk.evaluateBuy(symbols[0]!, 5_000_000, 0.01, 30);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason!, /already open/i);
});
