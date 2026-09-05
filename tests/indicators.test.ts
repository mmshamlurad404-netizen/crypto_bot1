import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emaSeries,
  calculateMACD,
  calculateBollinger,
  calculateStoch,
  calculateCloseRangePct,
  computeRichIndicators,
  calculateSMA,
} from "../src/indicators.js";

test("emaSeries seeds with SMA and tracks the trend", () => {
  const closes = [1, 2, 3, 4, 5, 6, 7, 8];
  const series = emaSeries(closes, 3);
  assert.equal(series[2], 2, "first EMA must equal SMA of the first period");
  assert.ok((series[7] as number) > 6, "EMA on a rising series lags below the latest close but stays high");
  assert.equal(series[0], null);
});

test("MACD is positive on a steady uptrend and histogram positive on accelerating growth", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.005, i));
  const res = calculateMACD(closes);
  assert.notEqual(res.macd, null);
  assert.notEqual(res.signal, null);
  assert.notEqual(res.histogram, null);
  assert.ok((res.macd as number) > 0);
  assert.ok((res.histogram as number) > 0, "histogram must stay positive while growth is exponential");
});

test("MACD requires fast<slow bars plus signal history before it is defined", () => {
  assert.deepEqual(calculateMACD([1, 2, 3]), { macd: null, signal: null, histogram: null });
  const res = calculateMACD(Array.from({ length: 100 }, () => 100));
  assert.notEqual(res.macd, null);
});

test("bollinger middle is the SMA and bands widen around it", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 10);
  const boll = calculateBollinger(closes);
  const mid = calculateSMA(closes, 20);
  assert.ok(boll.middle !== null && Math.abs(boll.middle - (mid as number)) < 1e-9);
  assert.ok((boll.upper as number) > (boll.middle as number) && (boll.middle as number) > (boll.lower as number));
  const short = calculateBollinger([1, 2, 3], 20);
  assert.equal(short.upper, null);
});

test("stoch is bounded 0..100 and saturates near 100 on a strong rally", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const stoch = calculateStoch(closes);
  assert.ok(stoch.k !== null && stoch.d !== null);
  assert.ok((stoch.k as number) >= 99.9, "relentless rally should pin %K near the top");
  assert.ok((stoch.d as number) >= 99);
  assert.ok((stoch.k as number) <= 100 && (stoch.d as number) <= 100);
});

test("atr proxy is zero on a flat market and grows with chop", () => {
  assert.equal(calculateCloseRangePct(Array.from({ length: 30 }, () => 100)), 0);
  const choppy = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
  const pct = calculateCloseRangePct(choppy);
  assert.ok(pct !== null && pct > 0);
});

test("computeRichIndicators returns nulls until enough history and full values after", () => {
  assert.equal(computeRichIndicators([1, 2, 3], 14).macd, null);
  const closes = Array.from({ length: 120 }, (_, i) => 50 + Math.sin(i / 5) * 5 + i * 0.1);
  const rich = computeRichIndicators(closes, 14);
  assert.ok(rich.macd !== null && rich.macdHistPct !== null);
  assert.ok(rich.bollingerUpper !== null && rich.bollingerLower !== null);
  assert.ok(rich.stochK !== null && rich.stochD !== null);
  assert.ok(rich.atrPct !== null && rich.atrPct >= 0);
});
