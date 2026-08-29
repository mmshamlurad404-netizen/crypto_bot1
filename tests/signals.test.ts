import { test } from "node:test";
import assert from "node:assert/strict";
import { SignalBroker } from "../src/signals/broker.js";

test("routes sentiment intents to the subscribed handler and returns its result", () => {
  const broker = new SignalBroker();
  const seen: string[] = [];
  broker.onSentiment((intent) => {
    seen.push(intent.symbol);
    return { score: 1, count: 1 };
  });
  const res = broker.submit({ source: "sentiment-webhook", kind: "sentiment", symbol: "btc", sentiment: 0.8, receivedAt: "t" });
  assert.equal(res.accepted, true);
  assert.deepEqual(res.result, { score: 1, count: 1 });
  assert.deepEqual(seen, ["btc"]);
});

test("rejects sentiment intents without a numeric sentiment", () => {
  const broker = new SignalBroker();
  const res = broker.submit({ source: "sentiment-feed", kind: "sentiment", symbol: "btc", receivedAt: "t" });
  assert.equal(res.accepted, false);
  assert.match(res.error!, /numeric sentiment/);
  assert.equal(broker.stats().rejected, 1);
});

test("queues trade intents FIFO per symbol and drains to null", () => {
  const broker = new SignalBroker();
  broker.submit({ source: "tradingview", kind: "trade", symbol: "btc/rls", action: "BUY", price: 1, receivedAt: "a" });
  broker.submit({ source: "tradingview", kind: "trade", symbol: "btc/rls", action: "SELL", receivedAt: "b" });
  broker.submit({ source: "manual", kind: "trade", symbol: "eth/rls", action: "BUY", price: 3, receivedAt: "c" });
  assert.equal(broker.pendingTrades("btc/rls"), 2);
  assert.equal(broker.totalPendingTrades(), 3);
  const first = broker.shiftTrade("btc/rls");
  assert.equal(first!.action, "BUY");
  assert.equal(first!.source, "tradingview");
  assert.equal(first!.price, 1);
  assert.equal(broker.shiftTrade("btc/rls")!.action, "SELL");
  assert.equal(broker.shiftTrade("btc/rls"), null);
  assert.equal(broker.pendingTrades("btc/rls"), 0);
  assert.equal(broker.shiftTrade("eth/rls")!.symbol, "eth/rls");
});

test("rejects trade intents without BUY/SELL and unknown kinds", () => {
  const broker = new SignalBroker();
  const bad = broker.submit({ source: "tradingview", kind: "trade", symbol: "btc/rls", action: "HOLD", receivedAt: "t" });
  assert.equal(bad.accepted, false);
  assert.match(bad.error!, /BUY\/SELL/);
  const badKind = broker.submit({ source: "manual", kind: "signal", symbol: "btc/rls", receivedAt: "t" });
  assert.equal(badKind.accepted, false);
  assert.match(badKind.error!, /unknown intent kind/);
  assert.equal(broker.stats().rejected, 2);
});

test("sentiment intents with no subscriber are still accepted", () => {
  const broker = new SignalBroker();
  const res = broker.submit({ source: "sentiment-webhook", kind: "sentiment", symbol: "btc", sentiment: 0.4, receivedAt: "t" });
  assert.equal(res.accepted, true);
  assert.equal(res.result, undefined);
});
