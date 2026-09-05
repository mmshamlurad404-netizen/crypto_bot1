import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { Executor } from "../src/execution/executor.js";
import { MarketMakingStrategy } from "../src/strategy/mm.js";
import { createLogger } from "../src/logger.js";
import { OrderGateway } from "../src/execution/gateway.js";
import { SymbolPair } from "../src/types.js";

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
  trailingStopPct: 3,
  trailingStopActivatePct: 1.5,
  trailingTpPct: 0,
  trailingTpActivatePct: 2,
};

const DAY1 = new Date("2026-01-05T10:00:00.000Z").getTime();
const DAY2 = new Date("2026-01-06T10:00:00.000Z").getTime();

function baseSetup(now: () => number = Date.now) {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  return { db, client, feed };
}

function makePortfolio(db: AuditDb, client: NobitexClient, feed: PriceFeed, dryRun: boolean) {
  return new PortfolioManager(db, client, feed, symbols, "rls", dryRun, 100_000_000);
}

function makeRisk(db: AuditDb, feed: PriceFeed, portfolio: PortfolioManager, now: () => number = Date.now) {
  return new RiskManager(db, feed, portfolio, riskBase, now);
}

type StatusResp = { status: string; order?: Record<string, unknown>; code?: string; message?: string };

function liveSetup(now: () => number = Date.now) {
  const { db, client, feed } = baseSetup(now);
  const portfolio = makePortfolio(db, client, feed, false);
  const risk = makeRisk(db, feed, portfolio, now);
  const executor = new Executor(db, client, feed, portfolio, risk, false, 0.25, logger);
  const stub = client as unknown as { orderStatus: (i: { id?: number; clientOrderId?: string }) => Promise<StatusResp> };
  return { db, client, feed, portfolio, risk, executor, stub };
}

function trades(db: AuditDb): number {
  return db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length;
}

test("risk restart: a trigger halt persists and is restored on a new RiskManager (same day)", () => {
  const { db, client, feed } = baseSetup(() => DAY1);
  const portfolio = makePortfolio(db, client, feed, true);
  const risk1 = makeRisk(db, feed, portfolio, () => DAY1);
  risk1.haltTrading("manual halt for review");
  assert.equal(risk1.isHalted(), true);

  const portfolio2 = makePortfolio(db, client, feed, true);
  const risk2 = makeRisk(db, feed, portfolio2, () => DAY1);
  assert.equal(risk2.isHalted(), true, "halt must survive a same-process restart on the same day");
});

test("risk restart: a daily-loss halt is cleared when the process restarts on a new day", () => {
  const { db, client, feed } = baseSetup(() => DAY1);
  const portfolio = makePortfolio(db, client, feed, true);
  const risk1 = makeRisk(db, feed, portfolio, () => DAY1);
  db.setMeta("prev_day_equity", String(200_000_000));
  const verdict = risk1.evaluateBuy(pair, 5_000_000, null, null);
  assert.equal(verdict.halted, true, "daily loss should halt trading");
  assert.equal(risk1.isHalted(), true);

  const portfolio2 = makePortfolio(db, client, feed, true);
  const risk2 = makeRisk(db, feed, portfolio2, () => DAY2);
  assert.equal(risk2.isHalted(), false, "new day must clear a persisted daily-loss halt");
});

test("risk restart: trailing stop ratchet (peak + armed) survives a restart", () => {
  const { db, client, feed } = baseSetup(() => DAY1);
  const portfolio = makePortfolio(db, client, feed, true);
  db.insertPosition({ symbol: pair.key, openTs: new Date(DAY1).toISOString(), entryPrice: 100, amount: 1, orderId: null });

  const risk1 = makeRisk(db, feed, portfolio, () => DAY1);
  const warm = risk1.checkTrailingStops(pair, 115);
  assert.equal(warm.hit, false);
  assert.equal(warm.stopArmed, true, "trailing stop should arm above the activation pct");

  const portfolio2 = makePortfolio(db, client, feed, true);
  const risk2 = makeRisk(db, feed, portfolio2, () => DAY2);
  const drop = risk2.checkTrailingStops(pair, 100);
  assert.equal(drop.hit, true, "a restarted manager must keep the armed stop + peak and fire on the same pullback");
  assert.equal(drop.kind, "trailing_stop");
});

test("boot recovery: a live resting order that filled while down is booked exactly once", async () => {
  const { db, executor, stub } = liveSetup(() => DAY1);
  const oid = db.insertOrder({
    ts: new Date(DAY1).toISOString(),
    clientOrderId: "rec-1",
    symbol: pair.key,
    side: "buy",
    execution: "limit",
    amount: 1,
    price: 100,
    status: "new",
    dryRun: false,
    nobitexOrderId: "9001",
    error: null,
    kind: "entry",
  });
  stub.orderStatus = async () => ({ status: "ok", order: { status: "Done", matchedAmount: "1", averagePrice: "100.5" } });

  const report = await executor.recoverLiveOrders();
  assert.deepEqual(report, { checked: 1, filled: 1, canceled: 0, failed: 0, stillNew: 0, skippedMode: 0 });
  assert.equal(trades(db), 1, "a down-time fill must be booked as a trade");
  const order = db.getOrder(oid)!;
  assert.equal(order.status, "filled");
  const pos = db.getOpenPosition(pair.key)!;
  assert.equal(pos.amount, 1);
  assert.equal(pos.entryPrice, 100.5, "averagePrice must be used for the recovered fill");

  const report2 = await executor.recoverLiveOrders();
  assert.deepEqual(report2, { checked: 0, filled: 0, canceled: 0, failed: 0, stillNew: 0, skippedMode: 0 });
});

test("boot recovery: a live resting order that was canceled while down is marked canceled", async () => {
  const { db, executor, stub } = liveSetup(() => DAY1);
  db.insertOrder({
    ts: new Date(DAY1).toISOString(),
    clientOrderId: "rec-2",
    symbol: pair.key,
    side: "buy",
    execution: "limit",
    amount: 1,
    price: 90,
    status: "new",
    dryRun: false,
    nobitexOrderId: "9002",
    error: null,
    kind: "entry",
  });
  stub.orderStatus = async () => ({ status: "ok", order: { status: "Canceled", matchedAmount: "0" } });
  const report = await executor.recoverLiveOrders();
  assert.equal(report.canceled, 1);
  assert.equal(db.getMeta("risk.state_v1"), null);
  assert.equal(db.openOrders().length, 0);
  assert.equal(trades(db), 0);
});

test("boot recovery: orders from a different run mode are skipped, never touched", async () => {
  const { db, executor, stub } = liveSetup(() => DAY1);
  db.insertOrder({
    ts: new Date(DAY1).toISOString(),
    clientOrderId: "rec-3",
    symbol: pair.key,
    side: "buy",
    execution: "limit",
    amount: 1,
    price: 90,
    status: "new",
    dryRun: true,
    nobitexOrderId: null,
    error: null,
    kind: "entry",
  });
  let called = false;
  stub.orderStatus = async () => {
    called = true;
    return { status: "ok", order: { status: "Done", matchedAmount: "1" } };
  };
  const report = await executor.recoverLiveOrders();
  assert.equal(report.skippedMode, 1);
  assert.equal(called, false, "mode-mismatched orders must not be sent to the exchange");
  assert.equal(trades(db), 0);
});

test("mm restart: resting quote ids and inventory are re-adopted from the db at boot", async () => {
  const { db } = baseSetup(() => DAY1);
  const t = new Date(DAY1).toISOString();
  db.insertPosition({ symbol: pair.key, openTs: t, entryPrice: 100, amount: 2, orderId: null });
  const bidId = db.insertOrder({ ts: t, clientOrderId: "mmb-1", symbol: pair.key, side: "buy", execution: "limit", amount: 0.5, price: 99, status: "new", dryRun: true, nobitexOrderId: null, error: null, kind: "mm_bid" });
  const askId = db.insertOrder({ ts: t, clientOrderId: "mma-1", symbol: pair.key, side: "sell", execution: "limit", amount: 0.3, price: 101, status: "new", dryRun: true, nobitexOrderId: null, error: null, kind: "mm_ask" });

  const polled: number[] = [];
  const gateway: OrderGateway = {
    getBestPrices: () => ({ ask: 102, bid: 98 }),
    getLatestPrice: () => 100,
    getBalance: () => 0,
    placeLimit: async () => null,
    cancel: async () => true,
    poll: async (id: number) => {
      polled.push(id);
      return { status: "new" };
    },
    market: async () => null,
  };
  const mmConfig = {
    enabled: true,
    symbols: ["btc/rls"],
    spreadPct: 0.4,
    orderValue: 10_000_000,
    maxInventoryValue: 50_000_000,
    stopLossPct: 10,
    cooldownMs: 0,
    maxQuoteAgeMs: 60_000,
    minOrderValue: 1_000_000,
  };
  const mm = new MarketMakingStrategy(gateway, db, mmConfig, { tradingActive: true, allKeys: ["btc/rls"], now: () => DAY1 + 10_000 });
  mm.restore();
  await mm.manage(pair);

  assert.ok(polled.includes(bidId), "adopted bid order must be polled on the first manage tick");
  assert.ok(polled.includes(askId), "adopted ask order must be polled on the first manage tick");
});
