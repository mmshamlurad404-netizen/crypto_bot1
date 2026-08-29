import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { SentimentEngine } from "../src/sentiment/engine.js";
import { parseTradingViewAlert, SentimentWebhook } from "../src/sentiment/server.js";
import { SignalBroker } from "../src/signals/broker.js";
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
  assert.equal(intent!.symbol, "btc/rls");
  assert.equal(intent!.action, "BUY");
  assert.equal(intent!.price, 300000);
  assert.equal(intent!.source, "tradingview");
  assert.equal(intent!.receivedAt, "2026-08-26T00:00:00.000Z");
});

test("parseTradingViewAlert maps ticker to a symbol and close to a sell", () => {
  const { intent, error } = parseTradingViewAlert(
    JSON.stringify({ ticker: "BINANCE:BTCRLS", action: "close" }),
    symbols,
    "2026-08-26T00:00:00.000Z"
  );
  assert.equal(error, null);
  assert.equal(intent!.symbol, "btc/rls");
  assert.equal(intent!.action, "SELL");
  assert.equal(intent!.price, null);
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

async function startWebhook(tradingViewEnabled: boolean): Promise<{ db: AuditDb; broker: SignalBroker; webhook: SentimentWebhook; port: number }> {
  const db = new AuditDb(":memory:");
  const engine = new SentimentEngine(db, 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 0.1);
  const broker = new SignalBroker();
  broker.onSentiment((intent) => engine.ingest({ account: intent.account ?? "webhook", symbol: intent.symbol, sentiment: intent.sentiment!, confidence: intent.confidence }));
  const logger = createLogger("silent");
  const webhook = new SentimentWebhook(broker, "secret-token", 0, logger, "", { tradingViewEnabled, db, symbols });
  webhook.start();
  for (let i = 0; i < 50; i++) {
    if (webhook.boundPort() !== null) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const port = webhook.boundPort()!;
  assert.ok(port > 0, "webhook bound to a port");
  return { db, broker, webhook, port };
}

test("tradingview endpoint enqueues a buy intent and persists the alert", async () => {
  const { db, broker, webhook, port } = await startWebhook(true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tradingview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify({ symbol: "btc/rls", close: 250000, strategy: { order: { action: "buy" } } }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { accepted: number };
    assert.equal(json.accepted, 1);
    assert.equal(broker.pendingTrades("btc/rls"), 1);
    assert.equal(broker.shiftTrade("btc/rls")!.action, "BUY");
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

test("sentiment endpoint routes through the broker into the sentiment engine", async () => {
  const { db, webhook, port } = await startWebhook(true);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify([{ account: "@a", symbol: "btc", sentiment: 0.9, confidence: 1 }]),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { accepted: number; snapshots: unknown[] };
    assert.equal(json.accepted, 1);
    assert.equal(json.snapshots.length, 1);
    const events = db.getSentimentEvents(24 * 60 * 60 * 1000);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.symbol, "btc");
    assert.ok(Math.abs(events[0]!.sentiment - 0.9) < 1e-9);
  } finally {
    await webhook.stop();
  }
});
