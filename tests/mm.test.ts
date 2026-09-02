import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { Executor } from "../src/execution/executor.js";
import { MarketMakingStrategy, MmStrategyConfig } from "../src/strategy/mm.js";
import { OrderGateway, MarketResult } from "../src/execution/gateway.js";
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

function baseSetup() {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  const portfolio = new PortfolioManager(db, client, feed, symbols, "rls", true, 100_000_000);
  portfolio.refresh().catch(() => undefined);
  const risk = new RiskManager(db, feed, portfolio, riskBase);
  return { db, client, feed, portfolio, risk };
}

async function seedBestPrices(feed: PriceFeed, client: NobitexClient, ask: number, bid: number) {
  (client as unknown as { marketStats: () => Promise<Record<string, { isClosed: boolean; bestSell: string; bestBuy: string }>> }).marketStats = async () => ({
    "btc-rls": { isClosed: false, bestSell: String(ask), bestBuy: String(bid) },
  });
  await feed.poll();
}

function mmConfig(overrides: Partial<MmStrategyConfig> = {}): MmStrategyConfig {
  return {
    enabled: true,
    symbols: [],
    spreadPct: 1,
    orderValue: 1_000_000,
    maxInventoryValue: 5_000_000,
    stopLossPct: 3,
    cooldownMs: 0,
    maxQuoteAgeMs: 300_000,
    minOrderValue: 0,
    ...overrides,
  };
}

class FakeGateway implements OrderGateway {
  best = { ask: 100.5, bid: 99.5 };
  latest = 100;
  balances: Map<string, number> = new Map();
  placed: { side: string; amount: number; price: number; kind: string; id: number }[] = [];
  pending: Map<number, { side: "buy" | "sell"; price: number }> = new Map();
  fills: Map<number, { fillPrice: number; filledAmount: number }> = new Map();
  cancelled: number[] = [];
  marketCalls: { side: string; amount: number; kind: string; price: number }[] = [];
  marketResult: MarketResult | null = null;
  private nextId = 1;

  getBestPrices(): { ask: number | null; bid: number | null } {
    return this.best;
  }
  getLatestPrice(): number | null {
    return this.latest;
  }
  getBalance(currency: string): number {
    return this.balances.get(currency) ?? 0;
  }
  async placeLimit(pair: SymbolPair, side: "buy" | "sell", amount: number, price: number, kind: string): Promise<number | null> {
    const id = this.nextId++;
    this.placed.push({ side, amount, price, kind, id });
    this.pending.set(id, { side, price });
    return id;
  }
  async cancel(orderId: number): Promise<boolean> {
    this.cancelled.push(orderId);
    this.pending.delete(orderId);
    return true;
  }
  async poll(orderId: number) {
    const fill = this.fills.get(orderId);
    if (fill) return { status: "filled", fillPrice: fill.fillPrice, filledAmount: fill.filledAmount };
    if (this.pending.has(orderId)) return { status: "new" };
    return { status: "canceled" };
  }
  async market(pair: SymbolPair, side: "buy" | "sell", amount: number, kind: string): Promise<MarketResult | null> {
    this.marketCalls.push({ side, amount, kind, price: this.latest });
    return this.marketResult;
  }
}

test("config: market making is OFF by default and parses when enabled", () => {
  const off = loadConfig({ SYMBOLS: "btc/rls" });
  assert.equal(off.mm.enabled, false);
  assert.equal(off.mm.spreadPct, 0.5);
  const on = loadConfig({
    SYMBOLS: "btc/rls",
    MM_ENABLED: "true",
    MM_SYMBOLS: "btc/rls",
    MM_SPREAD_PCT: "0.8",
    MM_ORDER_VALUE: "20000000",
    MM_MAX_INVENTORY_VALUE: "40000000",
    MM_STOP_LOSS_PCT: "5",
    MM_COOLDOWN_SECONDS: "120",
    MM_MAX_QUOTE_AGE_SECONDS: "600",
  });
  assert.equal(on.mm.enabled, true);
  assert.deepEqual(on.mm.symbols, ["btc/rls"]);
  assert.equal(on.mm.spreadPct, 0.8);
  assert.equal(on.mm.orderValue, 20_000_000);
  assert.equal(on.mm.maxInventoryValue, 40_000_000);
  assert.equal(on.mm.stopLossPct, 5);
  assert.equal(on.mm.cooldownMs, 120_000);
  assert.equal(on.mm.maxQuoteAgeMs, 600_000);
  assert.throws(() => loadConfig({ SYMBOLS: "btc/rls", MM_SYMBOLS: "eth/rls" }), /MM_SYMBOLS references symbol "eth\/rls"/);
  assert.throws(
    () => loadConfig({ SYMBOLS: "btc/rls", STRATEGY_POOLS: '{"btc/rls":"mm"}' }),
    /"mm" strategy but MM_ENABLED is not set/
  );
});

test("executor gateway: placeLimit rests, dry-run poll fills a buy when the ask crosses, cancel cancels", async () => {
  const { db, client, feed, portfolio, risk } = baseSetup();
  await seedBestPrices(feed, client, 100.5, 99.5);
  const executor = new Executor(db, client, feed, portfolio, risk, true, 0.25, logger);

  const id = await executor.placeLimit(pair, "buy", 10_000, 99.5, "mm_bid");
  assert.ok(id !== null);
  const placed = db.getOrder(id!);
  assert.equal(placed!.status, "new");
  assert.equal(placed!.execution, "limit");
  assert.equal(placed!.kind, "mm_bid");

  const noFill = await executor.poll(id!);
  assert.equal(noFill.status, "new", "ask 100.5 is not below the 99.5 bid");

  await seedBestPrices(feed, client, 99, 98.5);
  const fill = await executor.poll(id!);
  assert.equal(fill.status, "filled");
  assert.equal(fill.fillPrice, 99.5);
  const pos = db.getOpenPosition(pair.key);
  assert.ok(pos);
  assert.equal(pos!.amount, 10_000);
  assert.equal(portfolio.getBalance("btc"), 10_000);

  const cancelId = await executor.placeLimit(pair, "buy", 5_000, 95, "mm_bid");
  assert.ok(cancelId !== null);
  await executor.cancel(cancelId!);
  assert.equal(db.getOrder(cancelId!)!.status, "canceled");
  assert.equal((await executor.poll(cancelId!)).status, "canceled");
});

test("executor gateway: dry-run poll fills a sell when the bid crosses and records a trade", async () => {
  const { db, client, feed, portfolio, risk } = baseSetup();
  await seedBestPrices(feed, client, 100.5, 99.5);
  const executor = new Executor(db, client, feed, portfolio, risk, true, 0.25, logger);
  portfolio.applyTrade(pair, "buy", 10_000, 100, 0, null);

  const id = await executor.placeLimit(pair, "sell", 10_000, 100.5, "mm_ask");
  assert.ok(id !== null);
  await seedBestPrices(feed, client, 101, 100.5);
  const fill = await executor.poll(id!);
  assert.equal(fill.status, "filled");
  assert.equal(fill.fillPrice, 100.5);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, 1);
  assert.equal(portfolio.getBalance("btc"), 0, "inventory sold back out");
});

function executorSetup() {
  const setup = baseSetup();
  const executor = new Executor(setup.db, setup.client, setup.feed, setup.portfolio, setup.risk, true, 0.25, logger);
  return { ...setup, executor };
}

test("mm strategy (real gateway): bid-only with no inventory, both sides after a bid fill", async () => {
  const { db, feed, client, executor } = executorSetup();
  await seedBestPrices(feed, client, 100.5, 99.5);
  const strategy = new MarketMakingStrategy(executor, db, mmConfig());

  await strategy.manage(pair);
  const resting = db.getOrder(1)!;
  assert.equal(resting.kind, "mm_bid", "no inventory -> only a bid is quoted");
  assert.equal(resting.status, "new");

  await seedBestPrices(feed, client, 99, 98.5);
  await strategy.manage(pair);
  const orders = db.openOrders();
  assert.ok(orders.some((o) => o.kind === "mm_ask"), "after a bid fill the ask is quoted too");
  const pos = db.getOpenPosition(pair.key);
  assert.ok(pos);
  const expectedAmount = mmConfig().orderValue / 99.5;
  assert.ok(Math.abs(pos!.amount - expectedAmount) < 1, `position amount ~ orderValue / bid fill price, got ${pos!.amount}`);
  assert.equal(db.getOrder(1)!.status, "filled");
});

test("mm strategy (real gateway): ask fill sells the inventory and closes the position", async () => {
  const { db, feed, client, executor } = executorSetup();
  await seedBestPrices(feed, client, 100.5, 99.5);
  const strategy = new MarketMakingStrategy(executor, db, mmConfig());
  await strategy.manage(pair);

  await seedBestPrices(feed, client, 99, 98.5);
  await strategy.manage(pair);
  assert.ok(db.getOpenPosition(pair.key), "bid fill opened inventory");
  const askOrderId = db.openOrders().find((o) => o.kind === "mm_ask")!.id;

  await seedBestPrices(feed, client, 110, 109.5);
  await strategy.manage(pair);
  assert.equal(db.getOrder(askOrderId)!.status, "filled", "ask crossed by a rising best bid");
  assert.equal(db.getOpenPosition(pair.key), null, "inventory fully sold -> position closed");
});

test("mm strategy: stop-loss market-closes inventory when the mid drops below cost", async () => {
  const { db } = baseSetup();
  const gw = new FakeGateway();
  const strategy = new MarketMakingStrategy(gw, db, mmConfig());
  await strategy.manage(pair);
  gw.fills.set(gw.placed[0]!.id, { fillPrice: 99.5, filledAmount: 10_000 });
  await strategy.manage(pair);

  gw.best = { ask: 90.5, bid: 89.5 };
  gw.latest = 90;
  gw.marketResult = { price: 90, amount: 10_000 };
  await strategy.manage(pair);
  assert.equal(gw.marketCalls.length, 1);
  assert.equal(gw.marketCalls[0]!.side, "sell");
  assert.equal(gw.marketCalls[0]!.kind, "mm_exit");
});

test("mm strategy: cooldown suppresses requoting right after a fill", async () => {
  const { db } = baseSetup();
  const gw = new FakeGateway();
  const strategy = new MarketMakingStrategy(gw, db, mmConfig({ cooldownMs: 60_000 }));
  await strategy.manage(pair);
  const placedAfterFirst = gw.placed.length;
  gw.fills.set(gw.placed[0]!.id, { fillPrice: 99.5, filledAmount: 10_000 });
  await strategy.manage(pair);
  assert.equal(gw.placed.length, placedAfterFirst, "within the cooldown no new quotes are placed after the fill");
});

test("mm strategy (real gateway): stale quotes are cancelled after max quote age and requoted", async () => {
  const { db, feed, client, executor } = executorSetup();
  await seedBestPrices(feed, client, 100.5, 99.5);
  let now = 0;
  const strategy = new MarketMakingStrategy(executor, db, mmConfig({ maxQuoteAgeMs: 100 }), { now: () => now });

  await strategy.manage(pair);
  const first = db.getOrder(1)!;
  assert.equal(first.status, "new");

  now += 500;
  await strategy.manage(pair);
  assert.equal(db.getOrder(1)!.status, "canceled", "stale bid canceled after max quote age");
  const requote = db.openOrders().find((o) => o.kind === "mm_bid");
  assert.ok(requote, "a fresh bid replaces the stale one");
  assert.notEqual(requote!.id, first.id);
});

test("mm strategy (real gateway): max inventory caps the bid so a fill cannot overshoot", async () => {
  const { db, feed, client, executor } = executorSetup();
  const strategy = new MarketMakingStrategy(executor, db, mmConfig({ orderValue: 1_000_000, maxInventoryValue: 200_000, maxQuoteAgeMs: 10_000 }));
  await seedBestPrices(feed, client, 100.5, 99.5);
  await strategy.manage(pair);
  const bid = db.openOrders().find((o) => o.kind === "mm_bid")!;
  assert.equal(bid.amount, 2_000, "bid amount capped by maxInventory/mid (200_000/100), not by orderValue");
  assert.equal(db.getOpenPosition(pair.key), null, "resting quote alone does not create inventory");

  await seedBestPrices(feed, client, 99, 98.5);
  await strategy.manage(pair);
  const pos = db.getOpenPosition(pair.key);
  assert.ok(pos);
  assert.ok(pos!.amount <= 2_000 + 1e-6, `fill cannot exceed the max inventory cap, got ${pos!.amount}`);
  const invValue = pos!.amount * 98.75;
  assert.ok(invValue <= 200_000 + 1e-6, `inventory value stays within the cap, got ${invValue}`);
});

test("mm strategy: disabled symbol or monitor-only mode does nothing", async () => {
  const { db } = baseSetup();
  const gw = new FakeGateway();
  const disabledSymbol = new MarketMakingStrategy(gw, db, mmConfig({ symbols: ["eth/rls"] }));
  await disabledSymbol.manage(pair);
  assert.equal(gw.placed.length, 0);

  const gw2 = new FakeGateway();
  const monitorOnly = new MarketMakingStrategy(gw2, db, mmConfig(), { tradingActive: false });
  await monitorOnly.manage(pair);
  assert.equal(gw2.placed.length, 0, "monitor-only mode never places quotes");
});

test("mm strategy: respects a risk halt", async () => {
  const { db, feed, portfolio, risk } = baseSetup();
  const gw = new FakeGateway();
  const strategy = new MarketMakingStrategy(gw, db, mmConfig(), { halted: () => risk.isHalted() });
  risk.haltTrading("test halt");
  await strategy.manage(pair);
  assert.equal(gw.placed.length, 0, "halted bot does not quote");
});
