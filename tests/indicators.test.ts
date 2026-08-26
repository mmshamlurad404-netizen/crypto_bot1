import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateRSI, calculateVolatility, computeIndicators, calculateSMA, calculateEMA } from "../src/indicators.js";

test("RSI returns null with insufficient data", () => {
  assert.equal(calculateRSI([100, 101], 14), null);
});

test("RSI is 100 when only gains", () => {
  const closes: number[] = [];
  for (let i = 1; i <= 30; i++) closes.push(100 + i);
  const rsi = calculateRSI(closes, 14);
  assert.equal(rsi, 100);
});

test("RSI is 0 when only losses", () => {
  const closes: number[] = [];
  for (let i = 1; i <= 30; i++) closes.push(200 - i);
  const rsi = calculateRSI(closes, 14);
  assert.equal(rsi, 0);
});

test("RSI ~50 for flat alternating series", () => {
  const closes = [10];
  for (let i = 1; i < 100; i++) {
    closes.push(closes[i - 1]! + (i % 2 === 0 ? 1 : -1));
  }
  const rsi = calculateRSI(closes, 14)!;
  assert.ok(rsi > 40 && rsi < 60, `expected near 50, got ${rsi}`);
});

test("volatility of constant series is ~0", () => {
  const closes = Array.from({ length: 100 }, () => 100);
  const vol = calculateVolatility(closes, 60)!;
  assert.ok(Math.abs(vol) < 1e-9);
});

test("volatility scales with price swings", () => {
  const steady = Array.from({ length: 100 }, (_, i) => 100 + i * 0.01);
  const wild = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
  const vSteady = calculateVolatility(steady, 60)!;
  const vWild = calculateVolatility(wild, 60)!;
  assert.ok(vWild > vSteady, `expected wild=${vWild} > steady=${vSteady}`);
});

test("computeIndicators returns price", () => {
  const res = computeIndicators([100, 101, 102], 14);
  assert.equal(res.price, 102);
});

test("SMA is the mean of the trailing window", () => {
  assert.equal(calculateSMA([1, 2, 3, 4], 4), 2.5);
  assert.equal(calculateSMA([1, 2, 3, 4, 5, 6], 3), 5, "uses only the last `period` values");
  assert.equal(calculateSMA([1, 2], 3), null, "insufficient data");
});

test("EMA smooths with exponential weighting", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const sma = calculateSMA(closes, 10)!;
  const ema = calculateEMA(closes, 10)!;
  assert.notEqual(ema, sma);
  const flat = Array.from({ length: 20 }, () => 100);
  assert.equal(calculateEMA(flat, 10), 100);
  assert.equal(calculateEMA([1, 2], 3), null, "insufficient data");
  const rising = Array.from({ length: 30 }, (_, i) => 50 + i);
  const fallback = calculateEMA(rising, 5)!;
  assert.ok(fallback > 0);
});
