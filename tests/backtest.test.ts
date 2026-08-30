import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { toUdfSymbol } from "../src/market/priceFeed.js";
import { loadHistory, BacktestBar } from "../src/backtest/data.js";
import { runBacktest } from "../src/backtest/engine.js";
import { SymbolPair, SentimentInput } from "../src/types.js";

const pair: SymbolPair = { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" };

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({ SYMBOLS: "btc/rls", ...overrides });
}

function barsFromCloses(closes: number[], startTs: number, stepMs = 60_000): BacktestBar[] {
  return closes.map((close, i) => {
    const ts = startTs + i * stepMs;
    return { ts, open: close, high: close, low: close, close, volume: 1 };
  });
}

function constantSentiment(bars: BacktestBar[], value: number): SentimentInput[] {
  return bars.map((b) => ({ account: "test-account", symbol: pair.src, sentiment: value, confidence: 1, timestamp: b.ts }));
}

test("toUdfSymbol maps rls quote to irt and passthrough others", async () => {
  assert.equal(toUdfSymbol(pair), "BTCIRT");
  assert.equal(toUdfSymbol({ src: "eth", dst: "usdt", key: "eth/usdt", market: "ETH-USDT" }), "ETHUSDT");
});

test("loadHistory parses UDF bars and maps symbol", async () => {
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  let calledSymbol = "";
  (client as unknown as { udfHistory: (s: string, r: number, f: number, t: number) => Promise<unknown> }).udfHistory = async (symbol) => {
    calledSymbol = symbol;
    return { s: "ok", t: [1700000000, 1700003600], o: [10, 11], h: [12, 13], l: [9, 10], c: [10.5, 11.5], v: [1, 2] };
  };
  const bars = await loadHistory(client, pair, 1, 60);
  assert.equal(calledSymbol, "BTCIRT");
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.ts, 1700000000 * 1000);
  assert.equal(bars[1]!.close, 11.5);
});

test("no sentiment source → no trades, equity flat", async () => {
  const config = testConfig();
  const startTs = Date.UTC(2026, 0, 1);
  const bars = barsFromCloses(Array.from({ length: 80 }, (_, i) => 200 - i), startTs);
  const result = await runBacktest({ config, pair, bars, sentimentEvents: [], startEquity: 100_000_000 });
  assert.equal(result.metrics.roundTrips, 0);
  assert.equal(result.metrics.fills, 0);
  assert.equal(result.metrics.endEquity, 100_000_000);
  assert.ok(result.equityCurve.length === 80);
});

test("downtrend with bullish sentiment → buy then stop-loss sells (losses, no wins)", async () => {
  const config = testConfig({ STOP_LOSS_PCT: "3", TAKE_PROFIT_PCT: "50", RSI_OVERBOUGHT: "95", COOLDOWN_MINUTES: "0" });
  const startTs = Date.UTC(2026, 0, 1);
  const bars = barsFromCloses(Array.from({ length: 80 }, (_, i) => 200 - i), startTs);
  const sentiment = constantSentiment(bars, 0.8);
  const result = await runBacktest({ config, pair, bars, sentimentEvents: sentiment, startEquity: 100_000_000 });
  assert.ok(result.metrics.roundTrips >= 1, "expected at least one round trip");
  assert.ok(result.metrics.losses >= 1);
  assert.equal(result.metrics.wins, 0);
  assert.equal(result.metrics.profitFactor, 0);
  assert.ok(result.metrics.endEquity < result.metrics.startEquity);
  assert.equal(result.metrics.buys, result.metrics.sells);
});

test("decline then rebound → single buy + take-profit sell (win)", async () => {
  const config = testConfig({ STOP_LOSS_PCT: "50", TAKE_PROFIT_PCT: "1", RSI_OVERBOUGHT: "95", COOLDOWN_MINUTES: "0" });
  const startTs = Date.UTC(2026, 0, 1);
  const decline = Array.from({ length: 70 }, (_, i) => 200 - (i * 100) / 69);
  const rebound = Array.from({ length: 30 }, (_, i) => 100 + (i * 100) / 29);
  const bars = barsFromCloses([...decline, ...rebound], startTs);
  const sentiment = constantSentiment(bars, 0.8);
  const result = await runBacktest({ config, pair, bars, sentimentEvents: sentiment, startEquity: 100_000_000 });
  assert.equal(result.metrics.buys, 1);
  assert.equal(result.metrics.sells, 1);
  assert.equal(result.roundTrips.length, 1);
  assert.ok(result.roundTrips[0]!.realizedPnl > 0, `expected profit, got ${result.roundTrips[0]!.realizedPnl}`);
  assert.ok(result.metrics.endEquity > result.metrics.startEquity);
  assert.equal(result.metrics.wins, 1);
  assert.equal(result.metrics.winRatePct, 100);
  assert.ok(result.metrics.profitFactor !== null && result.metrics.profitFactor > 1);
  assert.ok(result.metrics.maxDrawdownPct >= 0);
});

test("sentiment drives entries: neutral sentiment with low RSI stays flat", async () => {
  const config = testConfig({ RSI_ENTRY_UPPER: "35" });
  const startTs = Date.UTC(2026, 0, 1);
  const bars = barsFromCloses(Array.from({ length: 60 }, (_, i) => 200 - i * 2), startTs);
  const sentiment = constantSentiment(bars, 0);
  const result = await runBacktest({ config, pair, bars, sentimentEvents: sentiment, startEquity: 100_000_000 });
  assert.equal(result.metrics.roundTrips, 0);
  assert.equal(result.metrics.fills, 0);
});
