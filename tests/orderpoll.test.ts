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
  trailingStopPct: 0,
  trailingStopActivatePct: 1.5,
  trailingTpPct: 0,
  trailingTpActivatePct: 2,
};

type StatusResp = { status: string; order?: Record<string, unknown>; code?: string; message?: string };
type CancelResp = { status: string; updatedStatus?: string; order?: Record<string, unknown>; code?: string; message?: string };

type ClientStub = {
  addOrder: (p: {
    type: "buy" | "sell";
    execution: "market" | "limit";
    srcCurrency: string;
    dstCurrency: string;
    amount: string;
    price?: string;
    clientOrderId: string;
  }) => Promise<StatusResp>;
  orderStatus: (i: { id?: number; clientOrderId?: string }) => Promise<StatusResp>;
  cancelOrder: (id: number) => Promise<CancelResp>;
};

function liveSetup() {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  const portfolio = new PortfolioManager(db, client, feed, symbols, "rls", false, 100_000_000);
  const risk = new RiskManager(db, feed, portfolio, riskBase);
  const executor = new Executor(db, client, feed, portfolio, risk, false, 0.25, logger);
  const stub = client as unknown as ClientStub;
  return { db, client, feed, portfolio, risk, executor, stub };
}

function trades(db: AuditDb): number {
  return db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length;
}

function order(id: number, over: Record<string, unknown>): Record<string, unknown> {
  return { id, status: "Active", price: "100", amount: "10", matchedAmount: "0", ...over };
}

test("live poll: resting order fills fully at Done and books the trade once", async () => {
  const { db, executor, stub } = liveSetup();
  let calls: Array<{ id?: number; clientOrderId?: string }> = [];
  stub.addOrder = async () => ({ status: "ok", order: order(7001, {}) });
  stub.orderStatus = async (i) => {
    calls.push(i);
    return { status: "ok", order: order(7001, { status: "Done", matchedAmount: "10" }) };
  };
  stub.cancelOrder = async () => ({ status: "ok" });

  const id = await executor.placeLimit(pair, "buy", 10, 100, "mm_bid");
  assert.ok(id !== null);
  assert.equal(db.getOrder(id!)!.status, "new", "placed order rests until the poll observes the fill");
  const res = await executor.poll(id!);
  assert.equal(res.status, "filled");
  assert.equal(res.filledAmount, 10);
  assert.equal(res.fillPrice, 100, "averagePrice missing -> falls back to the limit price");
  assert.equal(trades(db), 1);
  assert.equal(db.getOpenPosition(pair.key)!.amount, 10);
  assert.deepEqual(calls, [{ id: 7001 }], "looked up by the stored exchange order id");
});

test("live poll: averagePrice wins over the limit price for full fills", async () => {
  const { db, executor, stub } = liveSetup();
  stub.addOrder = async () => ({ status: "ok", order: order(7002, {}) });
  stub.orderStatus = async () => ({ status: "ok", order: order(7002, { status: "Done", matchedAmount: "10", averagePrice: "99.7" }) });
  stub.cancelOrder = async () => ({ status: "ok" });

  const id = await executor.placeLimit(pair, "buy", 10, 100, "mm_bid");
  const res = await executor.poll(id!);
  assert.equal(res.status, "filled");
  assert.equal(res.fillPrice, 99.7);
  assert.equal(trades(db), 1);
});

test("live poll: partial Active fill is deferred and only booked when the order terminates canceled", async () => {
  const { db, executor, stub } = liveSetup();
  stub.addOrder = async () => ({ status: "ok", order: order(7003, {}) });
  let cancelCalls = 0;
  stub.cancelOrder = async () => {
    cancelCalls++;
    return { status: "ok", updatedStatus: "Canceled", order: order(7003, { status: "Canceled", matchedAmount: "4" }) };
  };
  let exchangeStatus = "Active";
  let matched = "4";
  stub.orderStatus = async () => ({ status: "ok", order: order(7003, { status: exchangeStatus, matchedAmount: matched }) });

  const id = await executor.placeLimit(pair, "buy", 10, 100, "mm_bid");
  const partial = await executor.poll(id!);
  assert.equal(partial.status, "new", "partial fill while Active does not book yet");
  assert.equal(trades(db), 0);

  const cancelled = await executor.cancel(id!);
  assert.equal(cancelled, false, "cancel raced a partial fill -> caller keeps polling so the fill is booked once");
  assert.equal(db.getOrder(id!)!.status, "new", "order left open for the terminal booking");
  assert.equal(cancelCalls, 1);

  exchangeStatus = "Canceled";
  const res = await executor.poll(id!);
  assert.equal(res.status, "filled");
  assert.equal(res.filledAmount, 4, "only the matched portion is booked");
  assert.equal(trades(db), 1);
  const pos = db.getOpenPosition(pair.key)!;
  assert.equal(pos.amount, 4);
});

test("live poll: immediate fill at placeLimit is a resting order that books on the next poll (not a failure)", async () => {
  const { db, executor, stub } = liveSetup();
  stub.addOrder = async () => ({ status: "ok", order: order(7004, { status: "Done", matchedAmount: "10" }) });
  stub.orderStatus = async () => ({ status: "ok", order: order(7004, { status: "Done", matchedAmount: "10" }) });
  stub.cancelOrder = async () => ({ status: "ok" });

  const id = await executor.placeLimit(pair, "sell", 10, 100, "mm_ask");
  assert.ok(id !== null, "an already-crossed quote is placed, not rejected");
  assert.notEqual(db.getOrder(id!)!.status, "failed");
  const res = await executor.poll(id!);
  assert.equal(res.status, "filled");
  assert.equal(res.filledAmount, 10);
  assert.equal(trades(db), 1);
});

test("live poll: clean cancel without residual marks the order canceled and books nothing", async () => {
  const { db, executor, stub } = liveSetup();
  stub.addOrder = async () => ({ status: "ok", order: order(7005, {}) });
  stub.cancelOrder = async () => ({ status: "ok", updatedStatus: "Canceled", order: order(7005, { status: "Canceled", matchedAmount: "0" }) });
  stub.orderStatus = async () => ({ status: "ok", order: order(7005, {}) });

  const id = await executor.placeLimit(pair, "buy", 10, 100, "mm_bid");
  const cancelled = await executor.cancel(id!);
  assert.equal(cancelled, true);
  assert.equal(db.getOrder(id!)!.status, "canceled");
  assert.equal(trades(db), 0);
  const res = await executor.poll(id!);
  assert.equal(res.status, "canceled");
});

test("live poll: falls back to clientOrderId when the id lookup fails", async () => {
  const { db, executor, stub } = liveSetup();
  stub.addOrder = async () => ({ status: "ok", order: order(7006, {}) });
  const calls: Array<{ id?: number; clientOrderId?: string }> = [];
  stub.orderStatus = async (i) => {
    calls.push(i);
    if (i.clientOrderId) return { status: "ok", order: order(7006, { status: "Done", matchedAmount: "10" }) };
    return { status: "failed", code: "OrderNotFound" };
  };
  stub.cancelOrder = async () => ({ status: "ok" });

  const id = await executor.placeLimit(pair, "buy", 10, 100, "mm_bid");
  const res = await executor.poll(id!);
  assert.equal(res.status, "filled");
  assert.equal(calls.length, 2, "retried by clientOrderId after the id lookup failed");
  assert.ok(calls[1]!.clientOrderId);
  assert.equal(trades(db), 1);
});

test("live poll: still resting when both lookups fail to locate the order", async () => {
  const { db, executor, stub } = liveSetup();
  stub.addOrder = async () => ({ status: "ok", order: order(7007, {}) });
  stub.orderStatus = async () => ({ status: "failed", code: "OrderNotFound" });
  stub.cancelOrder = async () => ({ status: "ok" });

  const id = await executor.placeLimit(pair, "buy", 10, 100, "mm_bid");
  const res = await executor.poll(id!);
  assert.equal(res.status, "new");
  assert.equal(trades(db), 0);
});

test("market maker over a live executor: a partial fill that is cancelled mid-tick books once into inventory", async () => {
  const { db, client, feed, portfolio, risk, executor, stub } = liveSetup();
  (client as unknown as { marketStats: () => Promise<Record<string, { isClosed: boolean; bestSell: string; bestBuy: string }>> }).marketStats = async () => ({
    "btc-rls": { isClosed: false, bestSell: "100.5", bestBuy: "99.5" },
  });
  await feed.poll();

  const exchangeOrder = order(7101, { status: "Active", matchedAmount: "0", price: "99.5" });
  stub.addOrder = async () => ({ status: "ok", order: exchangeOrder });
  stub.cancelOrder = async () => {
    exchangeOrder.status = "Canceled";
    return { status: "ok", updatedStatus: "Canceled", order: exchangeOrder };
  };
  stub.orderStatus = async () => ({ status: "ok", order: exchangeOrder });

  let now = 0;
  const mm = new MarketMakingStrategy(
    executor,
    db,
    { enabled: true, symbols: [], spreadPct: 1, orderValue: 1_000_000, maxInventoryValue: 5_000_000, stopLossPct: 3, cooldownMs: 0, maxQuoteAgeMs: 0, minOrderValue: 0 },
    { now: () => now, tradingActive: true }
  );

  await mm.manage(pair);
  const bid = db.openOrders().find((o) => o.kind === "mm_bid")!;
  const original = bid.amount;
  exchangeOrder.matchedAmount = String(original / 2);
  now += 1;

  await mm.manage(pair);
  assert.equal(db.getOrder(bid.id)!.status, "new", "partial still resting: MM kept the order id after the partial cancel");

  exchangeOrder.status = "Canceled";
  now += 1;
  await mm.manage(pair);
  assert.equal(db.getOrder(bid.id)!.status, "filled");
  const pos = db.getOpenPosition(pair.key);
  assert.ok(pos);
  assert.ok(Math.abs(pos!.amount - original / 2) < 1e-6, `inventory reflects only the matched half, got ${pos!.amount}`);
  assert.equal(trades(db), 1, "exactly one booking despite the cancel");
  void risk;
  void portfolio;
});
