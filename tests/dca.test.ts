import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { HybridStrategy } from "../src/strategy/hybrid.js";
import { DcaLadder, DcaLevel } from "../src/strategy/dca.js";

const symbols = [
  { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" },
  { src: "eth", dst: "rls", key: "eth/rls", market: "ETH-RLS" },
];

function setup(opts: { levels?: DcaLevel[]; maxOrders?: number; enabled?: boolean; stopLossPct?: number } = {}) {
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
    stopLossPct: opts.stopLossPct ?? 20,
    takeProfitPct: 6,
    trailingStopPct: 0,
    trailingStopActivatePct: 1.5,
    trailingTpPct: 0,
    trailingTpActivatePct: 2,
  });
  const dca = new DcaLadder({
    enabled: opts.enabled ?? true,
    levels: opts.levels ?? [
      { belowPct: 5, buyPct: 5 },
      { belowPct: 10, buyPct: 5 },
    ],
    maxOrders: opts.maxOrders ?? 2,
  });
  const strategy = new HybridStrategy(
    db,
    feed,
    sentiment,
    portfolio,
    risk,
    {
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiEntryUpper: 35,
      sentimentEntryThreshold: 0.3,
      sentimentExitThreshold: -0.2,
    },
    dca
  );
  return { db, feed, portfolio, risk, sentiment, strategy, dca };
}

function pushCloses(feed: PriceFeed, prices: number[]) {
  let ts = Date.now() - prices.length * 1000;
  for (const p of prices) {
    feed.pushPrice("btc/rls", p, ts);
    ts += 1000;
  }
}

function descendingTo(feed: PriceFeed, end: number, start = 200, n = 41) {
  const step = (end - start) / (n - 1);
  pushCloses(feed, Array.from({ length: n }, (_, i) => start + i * step));
}

test("ladder disabled returns no level", () => {
  const ladder = new DcaLadder({ enabled: false, levels: [{ belowPct: 5, buyPct: 5 }], maxOrders: 2 });
  assert.equal(ladder.peek(1, 100, 90), null);
});

test("ladder picks a level only below its threshold", () => {
  const ladder = new DcaLadder({
    enabled: true,
    levels: [
      { belowPct: 5, buyPct: 5 },
      { belowPct: 10, buyPct: 5 },
    ],
    maxOrders: 2,
  });
  assert.equal(ladder.peek(1, 100, 96), null);
  const lvl = ladder.peek(1, 100, 95);
  assert.ok(lvl);
  assert.equal(lvl.belowPct, 5);
});

test("ladder consumes levels in order; gap-down still only consumes the next level", () => {
  const ladder = new DcaLadder({
    enabled: true,
    levels: [
      { belowPct: 5, buyPct: 5 },
      { belowPct: 10, buyPct: 5 },
      { belowPct: 15, buyPct: 5 },
    ],
    maxOrders: 3,
  });
  assert.equal(ladder.peek(1, 100, 70)!.belowPct, 5, "gap-down triggers the first unconsumed level only");
  ladder.consume(1);
  assert.equal(ladder.peek(1, 100, 70)!.belowPct, 10);
  ladder.consume(1);
  ladder.consume(1);
  assert.equal(ladder.peek(1, 100, 70), null, "all levels consumed");
});

test("ladder maxOrders caps below the level count", () => {
  const ladder = new DcaLadder({
    enabled: true,
    levels: [
      { belowPct: 5, buyPct: 5 },
      { belowPct: 10, buyPct: 5 },
    ],
    maxOrders: 1,
  });
  assert.ok(ladder.peek(1, 100, 95));
  ladder.consume(1);
  assert.equal(ladder.peek(1, 100, 90), null, "maxOrders reached");
});

test("evaluateDca skips the open-position gate that evaluateBuy enforces", () => {
  const { db, feed, risk } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  feed.pushPrice("btc/rls", 95);
  const buy = risk.evaluateBuy(symbols[0]!, 5_000_000, 0.01, 30);
  assert.equal(buy.allowed, false);
  assert.match(buy.reason!, /already open/i);
  const dca = risk.evaluateDca(symbols[0]!, 5_000_000, 0.01, 30);
  assert.equal(dca.allowed, true);
});

test("emits a DCA buy when price crosses the level while holding", () => {
  const { db, feed, strategy } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  descendingTo(feed, 95);
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY");
  assert.equal(decision.dca, true);
  assert.equal(decision.sizePct, 5);
  assert.match(decision.reason!, /DCA/);
});

test("DCA signal is consumed on approval; re-evaluate holds", () => {
  const { db, feed, strategy } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  descendingTo(feed, 95);
  assert.equal(strategy.evaluate(symbols[0]!).action, "BUY");
  const second = strategy.evaluate(symbols[0]!);
  assert.equal(second.action, "HOLD");
  assert.match(second.reason!, /holding/);
});

test("DCA blocked by risk leaves the level pending", () => {
  const { db, feed, strategy, dca } = setup({ levels: [{ belowPct: 5, buyPct: 0.1 }] });
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  descendingTo(feed, 95);
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "HOLD");
  assert.equal(dca.consumedCount(1), 0, "level not consumed when risk blocks");
  const after = strategy.evaluate(symbols[0]!);
  assert.equal(after.action, "HOLD", "level still pending, not consumed");
});

test("DCA fill merges the position and recomputes the average entry", () => {
  const { db, feed, portfolio, strategy } = setup();
  db.insertPosition({ symbol: "btc/rls", openTs: new Date().toISOString(), entryPrice: 100, amount: 1000, orderId: null });
  descendingTo(feed, 95);
  const decision = strategy.evaluate(symbols[0]!);
  assert.equal(decision.action, "BUY");
  const budget = portfolio.equity() * ((decision.sizePct ?? 5) / 100);
  const amount = budget / 95;
  portfolio.applyTrade(symbols[0]!, "buy", amount, 95, 0, null);
  const pos = db.getOpenPosition("btc/rls")!;
  const expectedEntry = (100 * 1000 + 95 * amount) / (1000 + amount);
  assert.ok(Math.abs(pos.entryPrice - expectedEntry) < 1e-9, `avg entry ${pos.entryPrice} vs ${expectedEntry}`);
  assert.equal(pos.amount, 1000 + amount);
});

test("migration adds orders.kind to pre-existing databases", () => {
  const path = `/tmp/opencode/migration-test-${Date.now()}.db`;
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      client_order_id TEXT UNIQUE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      execution TEXT NOT NULL,
      amount REAL NOT NULL,
      price REAL,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL,
      nobitex_order_id TEXT,
      error TEXT
    );
  `);
  raw.prepare("INSERT INTO orders (ts, symbol, side, execution, amount, status, dry_run) VALUES ('t', 'btc/rls', 'buy', 'market', 1, 'filled', 1)").run();
  raw.close();
  const db = new AuditDb(path);
  const kind = db.insertOrder({
    ts: "t2",
    clientOrderId: "c-2",
    symbol: "btc/rls",
    side: "buy",
    execution: "market",
    amount: 1,
    price: 100,
    status: "filled",
    dryRun: true,
    nobitexOrderId: null,
    error: null,
    kind: "dca",
  });
  const row = db.getOrder(kind);
  assert.ok(row);
  assert.equal(row.kind, "dca");
  const legacy = db.getOrder(1);
  assert.ok(legacy);
  assert.equal(legacy.kind, "entry", "pre-existing rows default to 'entry'");
  db.close();
});
