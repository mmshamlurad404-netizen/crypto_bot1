import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { parseTradingViewAlert, TradingViewSignals, SentimentWebhook } from "../src/sentiment/server.js";
import { createLogger } from "../src/logger.js";

const symbols = [
  { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" },
  { src: "eth", dst: "rls", key: "eth/rls", market: "ETH-RLS" },
];

test("parseTradingViewAlert maps strategy.order.action buy with explicit symbol and close", () => {
  const { intent, error } = parseTradingViewAlert(
    JSON.stringify({ symbol: "btc/rls", close: 300000, strategy: { order: { action: "buy" } } }),
    symbols,
    "2026-08-26T00:00:00.000Z"
  );
  assert.equal(error, null);
  assert.deepEqual(intent, { symbol: "btc/rls", action: "BUY", price: 300000, receivedAt: "2026-08-26T00:00:00.000Z" });
});

test("parseTradingViewAlert maps ticker to a symbol and close to a sell", () => {
  const { intent, error } = parseTradingViewAlert(
    JSON.stringify({ ticker: "BINANCE:BTCRLS", action: "close" }),
    symbols,
    "2026-08-26T00:00:00.000Z"
  );
  assert.equal(error, null);
  assert.deepEqual(intent, { symbol: "btc/rls", action: "SELL", price: null, receivedAt: "2026-08-26T00:00:00.000Z" });
});

test("parseTradingViewAlert treats hold as a no-op", () => {
  const { intent, error } = parseTradingViewAlert(JSON.stringify({ symbol: "btc/rls", action: "hold" }), symbols, "t");
  assert.equal(error, null);
  assert.equal(intent, null);
});

test("parseTradingViewAlert rejects unknown actions, symbols, and bad payloads", () => {
  const badAction = parseTradingViewAlert(JSON.stringify({ symbol: "btc/rls", action: "frobnicate" }), symbols, "t");
  assert.match(badAction.error!, /unsupported action/);
  const badSymbol = parseTradingViewAlert(JSON.stringify({ symbol: "ltc/usdt", action: "buy" }), symbols, "t");
  assert.match(badSymbol.error!, /no symbol match/);
  const badJson = parseTradingViewAlert("{nope", symbols, "t");
  assert.match(badJson.error!, /invalid JSON/);
  const nonObject = parseTradingViewAlert("[1,2]", symbols, "t");
  assert.match(nonObject.error!, /JSON object/);
});

test("TradingViewSignals store is FIFO per symbol and drains to null", () => {
  const store = new TradingViewSignals();
  store.enqueue({ symbol: "btc/rls", action: "BUY", price: 1, receivedAt: "a" });
  store.enqueue({ symbol: "btc/rls", action: "SELL", price: 2, receivedAt: "b" });
  store.enqueue({ symbol: "eth/rls", action: "BUY", price: 3, receivedAt: "c" });
  assert.equal(store.pendingCount("btc/rls"), 2);
  assert.equal(store.totalPending(), 3);
  assert.equal(store.shift("btc/rls")!.action, "BUY");
  assert.equal(store.shift("btc/rls")!.action, "SELL");
  assert.equal(store.shift("btc/rls"), null);
  assert.equal(store.pendingCount("btc/rls"), 0);
  assert.equal(store.shift("eth/rls")!.symbol, "eth/rls");
});

async function startWebhook(tradingViewEnabled: boolean): Promise<{ db: AuditDb; store: TradingViewSignals; webhook: SentimentWebhook; port: number }> {
  const db = new AuditDb(":memory:");
  const engine = new SentimentEngine(db, 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 0.1);
  const store = new TradingViewSignals();
  const logger = createLogger("silent");
  const webhook = new SentimentWebhook(engine, "secret-token", 0, logger, "", { tradingViewEnabled, signals: store, db, symbols });
  webhook.start();
  for (let i = 0; i < 50; i++) {
    if (webhook.boundPort() !== null) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const port = webhook.boundPort()!;
  assert.ok(port > 0, "webhook bound to a port");
  return { db, store, webhook, port };
}

test("tradingview endpoint enqueues a buy intent and persists the alert", async () => {
  const { db, store, webhook, port } = await startWebhook(true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tradingview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify({ symbol: "btc/rls", close: 250000, strategy: { order: { action: "buy" } } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { accepted: number };
    assert.equal(json.accepted, 1);
    assert.equal(store.pendingCount("btc/rls"), 1);
    assert.equal(store.shift("btc/rls")!.action, "BUY");
    assert.equal(db.countTradingViewSignals(), 1);
  } finally {
    await webhook.stop();
  }
});

test("tradingview endpoint requires bearer auth", async () => {
  const { webhook, port } = await startWebhook(true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tradingview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "btc/rls", action: "buy" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await webhook.stop();
  }
});

test("tradingview endpoint is disabled when TRADINGVIEW_ENABLED is off", async () => {
  const { webhook, port } = await startWebhook(false);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tradingview`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" },
      body: JSON.stringify({ symbol: "btc/rls", action: "buy" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await webhook.stop();
  }
});

test("tradingview endpoint rejects an unknown symbol with 400", async () => {
  const { webhook, port } = await startWebhook(true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tradingview`, {
      method: "POST",
      headers: { Authorization: "Bearer secret-token" },
      body: JSON.stringify({ symbol: "ltc/usdt", action: "buy" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await webhook.stop();
  }
});
