import { test } from "node:test";
import assert from "node:assert/strict";
import { TriggerEngine, TriggerRule } from "../src/triggers/engine.js";
import { loadConfig } from "../src/config.js";
import { AuditDb } from "../src/db.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";

function rule(over: Partial<TriggerRule> = {}): TriggerRule {
  return {
    id: "t1",
    symbol: "btc/rls",
    when: { type: "rsi_below", value: 25 },
    then: { type: "notify" },
    ...over,
  };
}

test("fires on rising edge, not while condition stays true", () => {
  const engine = new TriggerEngine([rule()]);
  assert.equal(engine.evaluate({ symbol: "btc/rls", rsi: 30, price: 100, sentiment: 0 }).length, 0);
  const fired = engine.evaluate({ symbol: "btc/rls", rsi: 20, price: 100, sentiment: 0 });
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.ruleId, "t1");
  assert.equal(engine.evaluate({ symbol: "btc/rls", rsi: 10, price: 100, sentiment: 0 }).length, 0, "still below, no re-fire");
});

test("re-arms when the condition goes back to false", () => {
  const engine = new TriggerEngine([rule()]);
  engine.evaluate({ symbol: "btc/rls", rsi: 20, price: 100, sentiment: 0 });
  assert.equal(engine.evaluate({ symbol: "btc/rls", rsi: 30, price: 100, sentiment: 0 }).length, 0);
  assert.equal(engine.evaluate({ symbol: "btc/rls", rsi: 15, price: 100, sentiment: 0 }).length, 1, "re-fires after crossing back");
});

test("supports rsi/price/sentiment conditions", () => {
  const engine = new TriggerEngine([
    rule({ id: "a", when: { type: "rsi_above", value: 70 } }),
    rule({ id: "b", when: { type: "price_below", value: 90 } }),
    rule({ id: "c", when: { type: "sentiment_above", value: 0.5 } }),
  ]);
  const events = engine.evaluate({ symbol: "btc/rls", rsi: 80, price: 85, sentiment: 0.9 });
  assert.deepEqual(events.map((e) => e.ruleId).sort(), ["a", "b", "c"]);
});

test("ignores rules for other symbols", () => {
  const engine = new TriggerEngine([
    rule({ id: "btc", symbol: "btc/rls", when: { type: "price_below", value: 90 } }),
    rule({ id: "eth", symbol: "eth/rls", when: { type: "price_below", value: 90 } }),
  ]);
  const events = engine.evaluate({ symbol: "btc/rls", rsi: 10, price: 80, sentiment: 0 });
  assert.deepEqual(events.map((e) => e.ruleId), ["btc"]);
});

test("null indicators never satisfy numeric conditions", () => {
  const engine = new TriggerEngine([rule()]);
  assert.equal(engine.evaluate({ symbol: "btc/rls", rsi: null, price: 100, sentiment: 0 }).length, 0);
});

test("carries action type and message; interpolates {symbol}", () => {
  const engine = new TriggerEngine([
    rule({ id: "notify", then: { type: "notify", message: "Alert on {symbol}!" } }),
    rule({ id: "halt", when: { type: "price_below", value: 90 }, then: { type: "halt" } }),
  ]);
  const events = engine.evaluate({ symbol: "btc/rls", rsi: 10, price: 80, sentiment: 0 });
  assert.equal(events.length, 2);
  const notify = events.find((e) => e.ruleId === "notify")!;
  assert.equal(notify.actionType, "notify");
  assert.equal(notify.message, "Alert on btc/rls!");
  const halt = events.find((e) => e.ruleId === "halt")!;
  assert.equal(halt.actionType, "halt");
  assert.match(halt.message, /price_below/);
});

test("count getter and reset clear edge state", () => {
  const engine = new TriggerEngine([rule()]);
  assert.equal(engine.count, 1);
  engine.evaluate({ symbol: "btc/rls", rsi: 20, price: 100, sentiment: 0 });
  engine.reset();
  assert.equal(engine.evaluate({ symbol: "btc/rls", rsi: 20, price: 100, sentiment: 0 }).length, 1, "fires again after reset");
});

test("config parses TRIGGERS and validates symbols", () => {
  const cfg = loadConfig({
    SYMBOLS: "btc/rls,eth/rls",
    TRIGGERS: '[{"id":"a","symbol":"btc/rls","when":{"type":"rsi_below","value":25},"then":{"type":"notify"}}]',
  });
  assert.equal(cfg.triggers.length, 1);
  assert.equal(cfg.triggers[0]!.id, "a");
});

test("config rejects TRIGGERS with an unknown symbol", () => {
  assert.throws(
    () => loadConfig({ SYMBOLS: "btc/rls", TRIGGERS: '[{"id":"a","symbol":"ltc/usdt","when":{"type":"rsi_below","value":25},"then":{"type":"notify"}}]' }),
    /not in SYMBOLS/
  );
});

test("config rejects TRIGGERS with invalid JSON or bad rules", () => {
  assert.throws(() => loadConfig({ SYMBOLS: "btc/rls", TRIGGERS: "not-json" }), /TRIGGERS must be a JSON array/);
  assert.throws(
    () => loadConfig({ SYMBOLS: "btc/rls", TRIGGERS: '[{"id":"a","symbol":"btc/rls","when":{"type":"bogus","value":1},"then":{"type":"notify"}}]' }),
    /Invalid enum/
  );
  assert.throws(
    () =>
      loadConfig({
        SYMBOLS: "btc/rls",
        TRIGGERS:
          '[{"id":"a","symbol":"btc/rls","when":{"type":"rsi_below","value":1},"then":{"type":"notify"}},{"id":"a","symbol":"btc/rls","when":{"type":"rsi_below","value":1},"then":{"type":"notify"}}]',
      }),
    /duplicate rule id/
  );
});

test("haltTrading halts subsequent buy approval", () => {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, [{ src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" }], 500, false);
  const portfolio = new PortfolioManager(db, client, feed, [{ src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" }], "rls", true, 100_000_000);
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
  feed.pushPrice("btc/rls", 100);
  assert.equal(risk.evaluateBuy({ src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" }, 5_000_000, 0.01, 30).allowed, true);
  risk.haltTrading("triggered circuit breaker");
  const verdict = risk.evaluateBuy({ src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" }, 5_000_000, 0.01, 30);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.halted, true);
  assert.match(verdict.reason!, /trading halted/i);
});
