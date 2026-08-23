import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { computeMetrics } from "../src/report/metrics.js";

const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();

function seed(db: AuditDb, positions: { openAgo: number; closeAgo: number; realized: number; symbol?: string }[], snapshots: { ts: string; equity: number; pv?: number }[], trades?: number) {
  for (const p of positions) {
    const id = db.insertPosition({ symbol: p.symbol ?? "btc/rls", openTs: daysAgo(p.openAgo), entryPrice: 100, amount: 1, orderId: null });
    db.closePosition(id, daysAgo(p.closeAgo), 100 + p.realized, p.realized, "sold");
  }
  for (const s of snapshots) {
    db.insertPortfolioSnapshot({ ts: s.ts, equity: s.equity, cash: s.equity - (s.pv ?? 0), positionsValue: s.pv ?? 0, unrealizedPnl: 0, realizedPnlDay: 0, data: "{}" });
  }
  if (trades !== undefined) {
    for (let i = 0; i < trades; i++) {
      db.insertTrade({ ts: daysAgo(i + 1), orderId: null, symbol: "btc/rls", side: "buy", amount: 1, price: 100, total: 100, fee: 0 });
    }
  }
}

test("computes win rate, profit factor and net PnL from closed positions", () => {
  const db = new AuditDb(":memory:");
  seed(db, [
    { openAgo: 20, closeAgo: 18, realized: 1000 },
    { openAgo: 15, closeAgo: 12, realized: 1500 },
    { openAgo: 10, closeAgo: 8, realized: -500 },
    { openAgo: 60, closeAgo: 55, realized: 9000 },
  ], []);
  const m = computeMetrics(db);
  assert.equal(m.roundTrips, 3, "positions older than 30d must be excluded");
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 1);
  assert.equal(m.winRatePct, (2 / 3) * 100);
  assert.equal(m.grossProfit, 2500);
  assert.equal(m.grossLoss, 500);
  assert.equal(m.netPnl, 2000);
  assert.equal(m.profitFactor, 5);
  assert.equal(m.avgWin, 1250);
  assert.equal(m.avgLoss, 500);
  db.close();
});

test("computes return, drawdown, exposure and Sharpe from snapshots", () => {
  const db = new AuditDb(":memory:");
  seed(db, [], [
    { ts: daysAgo(4), equity: 100_000, pv: 0 },
    { ts: daysAgo(3), equity: 95_000, pv: 10_000 },
    { ts: daysAgo(2), equity: 103_000, pv: 20_000 },
    { ts: daysAgo(1), equity: 99_000, pv: 5_000 },
    { ts: daysAgo(0), equity: 105_000, pv: 30_000 },
  ]);
  const m = computeMetrics(db);
  assert.equal(m.snapshots, 5);
  assert.equal(m.startEquity, 100_000);
  assert.equal(m.endEquity, 105_000);
  assert.equal(m.returnPct, 5);
  assert.ok(Math.abs(m.maxDrawdownPct! - 5) < 1e-9, `expected 5% drawdown, got ${m.maxDrawdownPct}`);
  assert.ok(m.avgExposurePct! > 0 && m.avgExposurePct! < 100);
  assert.ok(m.sharpe !== null && Number.isFinite(m.sharpe) && m.sharpe > 0, `expected positive sharpe, got ${m.sharpe}`);
  assert.ok(m.avgWinPct === null);
  db.close();
});

test("counts fills within range", () => {
  const db = new AuditDb(":memory:");
  seed(db, [], [], 7);
  const m = computeMetrics(db);
  assert.equal(m.trades, 7);
  assert.equal(m.roundTrips, 0);
  assert.equal(m.winRatePct, 0);
  assert.equal(m.profitFactor, null);
  db.close();
});

test("empty database returns zeros and nulls without error", () => {
  const db = new AuditDb(":memory:");
  const m = computeMetrics(db);
  assert.equal(m.roundTrips, 0);
  assert.equal(m.trades, 0);
  assert.equal(m.snapshots, 0);
  assert.equal(m.profitFactor, null);
  assert.equal(m.sharpe, null);
  assert.equal(m.maxDrawdownPct, null);
  assert.equal(m.returnPct, null);
  assert.equal(m.avgWin, null);
  db.close();
});

test("respects an explicit range", () => {
  const db = new AuditDb(":memory:");
  seed(db, [
    { openAgo: 20, closeAgo: 18, realized: 1000 },
    { openAgo: 15, closeAgo: 12, realized: 1500 },
  ], []);
  const from = daysAgo(10);
  const to = daysAgo(5);
  const m = computeMetrics(db, { fromTs: from, toTs: to });
  assert.equal(m.roundTrips, 0, "both positions closed outside the narrow range");
  const m2 = computeMetrics(db, { fromTs: daysAgo(19), toTs: daysAgo(17) });
  assert.equal(m2.roundTrips, 1);
  assert.equal(m2.netPnl, 1000);
  db.close();
});
