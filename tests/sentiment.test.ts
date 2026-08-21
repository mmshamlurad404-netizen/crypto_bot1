import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { SentimentEngine } from "../src/sentiment/engine.js";

function setup() {
  const db = new AuditDb(":memory:");
  const engine = new SentimentEngine(db, 24 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 0.1);
  return { db, engine };
}

test("aggregates weighted sentiment across accounts", () => {
  const { engine } = setup();
  const now = Date.now();
  engine.ingest({ account: "a", symbol: "btc", sentiment: 0.5, confidence: 1, timestamp: now });
  engine.ingest({ account: "b", symbol: "btc", sentiment: -0.5, confidence: 1, timestamp: now });
  const snap = engine.snapshot("btc");
  assert.equal(snap.score, 0);
  assert.equal(snap.count, 2);
  assert.deepEqual(snap.sources.sort(), ["a", "b"]);
});

test("recency-weighted scoring favors fresh signals", () => {
  const { engine } = setup();
  const now = Date.now();
  engine.ingest({ account: "old", symbol: "eth", sentiment: -1, confidence: 1, timestamp: now - 20 * 60 * 60 * 1000 });
  engine.ingest({ account: "fresh", symbol: "eth", sentiment: 1, confidence: 1, timestamp: now });
  const snap = engine.snapshot("eth");
  assert.ok(snap.score > 0.5, `expected positive bias, got ${snap.score}`);
});

test("stale entries outside window are dropped", () => {
  const { engine } = setup();
  const now = Date.now();
  engine.ingest({ account: "old", symbol: "eth", sentiment: -1, confidence: 1, timestamp: now - 25 * 60 * 60 * 1000 });
  engine.ingest({ account: "fresh", symbol: "eth", sentiment: 1, confidence: 1, timestamp: now });
  const snap = engine.snapshot("eth");
  assert.equal(snap.count, 1);
  assert.equal(snap.score, 1);
});

test("low-confidence entries are ignored", () => {
  const { engine } = setup();
  const now = Date.now();
  engine.ingest({ account: "noisy", symbol: "btc", sentiment: -1, confidence: 0.01, timestamp: now });
  const snap = engine.snapshot("btc");
  assert.equal(snap.count, 0);
});

test("sentiment clamped to [-1, 1]", () => {
  const { engine } = setup();
  const now = Date.now();
  engine.ingest({ account: "a", symbol: "btc", sentiment: 5, timestamp: now });
  engine.ingest({ account: "b", symbol: "btc", sentiment: -9, timestamp: now });
  const snap = engine.snapshot("btc");
  assert.ok(snap.score >= -1 && snap.score <= 1);
});
