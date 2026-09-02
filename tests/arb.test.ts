import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { NobitexClient } from "../src/exchange/nobitex.js";
import { PriceFeed } from "../src/market/priceFeed.js";
import { PortfolioManager } from "../src/portfolio/manager.js";
import { RiskManager } from "../src/risk/manager.js";
import { ArbitrageStrategy, ArbStrategyConfig } from "../src/strategy/arb.js";
import { BinanceArbClient, ArbExchangeClient } from "../src/exchange/arb.js";
import { OrderGateway, MarketResult } from "../src/execution/gateway.js";
import { SymbolPair } from "../src/types.js";

const pair: SymbolPair = { src: "btc", dst: "rls", key: "btc/rls", market: "BTC-RLS" };
const symbols = [pair];

const riskBase = {
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
};

class FakeArbClient implements ArbExchangeClient {
  exchangeName = "binance";
  ticker: { bid: number; ask: number } | null = { bid: 0, ask: 0 };
  balances: Map<string, number> = new Map();
  buys: string[] = [];
  sells: string[] = [];

  async getTicker(symbol: string) {
    return this.ticker;
  }
  async getBalance(asset: string) {
    return this.balances.get(asset) ?? 0;
  }
  async marketBuy(symbol: string, amount: number) {
    this.buys.push(symbol);
  }
  async marketSell(symbol: string, amount: number) {
    this.sells.push(symbol);
  }
}

class FakeGateway implements OrderGateway {
  best = { ask: 100.2, bid: 100 };
  latest = 100.1;
  balances: Map<string, number> = new Map();

  getBestPrices() {
    return this.best;
  }
  getLatestPrice() {
    return this.latest;
  }
  getBalance(currency: string) {
    return this.balances.get(currency) ?? 0;
  }
  async placeLimit(): Promise<number | null> {
    throw new Error("not used");
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async poll() {
    return { status: "new" as const };
  }
  async market(): Promise<MarketResult | null> {
    return null;
  }
}

function baseSetup() {
  const db = new AuditDb(":memory:");
  const client = new NobitexClient("https://apiv2.nobitex.ir", "");
  const feed = new PriceFeed(client, symbols, 500, false);
  const portfolio = new PortfolioManager(db, client, feed, symbols, "rls", true, 100_000_000);
  portfolio.refresh().catch(() => undefined);
  const risk = new RiskManager(db, feed, portfolio, riskBase);
  return { db, client, feed, portfolio, risk };
}

function arbConfig(overrides: Partial<ArbStrategyConfig> = {}): ArbStrategyConfig {
  return {
    enabled: true,
    exchange: "binance",
    symbols: { "btc/rls": "btcusdt" },
    fxRate: 0,
    minProfitPct: 0.1,
    maxNotionalPct: 1,
    cooldownMs: 0,
    ...overrides,
  };
}

test("config: arbitrage is OFF by default and parses when enabled", () => {
  const off = loadConfig({ SYMBOLS: "btc/rls" });
  assert.equal(off.arb.enabled, false);
  const on = loadConfig({
    SYMBOLS: "btc/rls",
    ARB_ENABLED: "true",
    ARB_EXCHANGE: "binance",
    ARB_SYMBOLS: '{"btc/rls":"btcusdt"}',
    ARB_FX_RATE: "280000",
    ARB_MIN_PROFIT_PCT: "0.2",
    ARB_MAX_NOTIONAL_PCT: "3",
    ARB_COOLDOWN_SECONDS: "600",
  });
  assert.equal(on.arb.enabled, true);
  assert.equal(on.arb.exchange, "binance");
  assert.deepEqual(on.arb.symbols, { "btc/rls": "btcusdt" });
  assert.equal(on.arb.fxRate, 280000);
  assert.equal(on.arb.minProfitPct, 0.2);
  assert.equal(on.arb.maxNotionalPct, 3);
  assert.equal(on.arb.cooldownMs, 600_000);
  assert.throws(() => loadConfig({ SYMBOLS: "btc/rls", ARB_SYMBOLS: '{"eth/rls":"ethusdt"}' }), /ARB_SYMBOLS references symbol "eth\/rls"/);
  assert.throws(
    () => loadConfig({ SYMBOLS: "btc/rls", STRATEGY_POOLS: '{"btc/rls":"arb"}' }),
    /"arb" strategy but ARB_ENABLED is not set/
  );
  assert.throws(
    () => loadConfig({ SYMBOLS: "btc/rls", ARB_ENABLED: "true", DRY_RUN: "false" }),
    /ARB_ENABLED requires USER_ARB_API_KEY and USER_ARB_API_SECRET/
  );
  const live = loadConfig({
    SYMBOLS: "btc/rls",
    ARB_ENABLED: "true",
    DRY_RUN: "false",
    USER_ARB_API_KEY: "k",
    USER_ARB_API_SECRET: "s",
  });
  assert.equal(live.arb.enabled, true);
});

test("arb strategy: detects a Nobitex-buy / arb-sell opportunity and simulates a round trip", async () => {
  const { db, client, portfolio, risk } = baseSetup();
  const arb = new FakeArbClient();
  arb.ticker = { bid: 101, ask: 101.1 };
  const gw = new FakeGateway();
  gw.best = { ask: 100, bid: 99.9 };
  const strategy = new ArbitrageStrategy(gw, client, portfolio, risk, arb, db, arbConfig(), {
    tradingActive: true,
    dryRun: true,
    feePct: 0.25,
  });

  await strategy.manage(pair);
  const expectedProfit = (101 - 100) * 10_000 - 100 * 10_000 * 0.0025 - 101 * 10_000 * 0.0025;
  assert.equal(portfolio.getBalance("rls"), 100_000_000 + expectedProfit);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, 2);
  assert.equal(db.getOrder(1)!.kind, "arb");
  assert.equal(db.getOrder(2)!.kind, "arb");
  assert.equal(arb.buys.length, 0, "dry-run never touches the second exchange");
  assert.equal(arb.sells.length, 0);
});

test("arb strategy: detects a arb-buy / Nobitex-sell opportunity (reverse direction)", async () => {
  const { db, client, portfolio, risk } = baseSetup();
  const arb = new FakeArbClient();
  arb.ticker = { bid: 99.2, ask: 99 };
  const gw = new FakeGateway();
  gw.best = { ask: 100.2, bid: 100 };
  const strategy = new ArbitrageStrategy(gw, client, portfolio, risk, arb, db, arbConfig(), {
    tradingActive: true,
    dryRun: true,
    feePct: 0.25,
  });

  await strategy.manage(pair);
  assert.equal(arb.buys.length, 0, "dry-run never touches the second exchange");
  assert.equal(db.getOrder(1)!.side, "buy");
  assert.equal(db.getOrder(1)!.price, 99, "arb leg bought at its ask");
  assert.equal(db.getOrder(2)!.side, "sell");
  assert.equal(db.getOrder(2)!.price, 100, "Nobitex leg sells at its bid");
  assert.ok(portfolio.getBalance("rls") > 100_000_000, "reverse round trip is profitable");
});

test("arb strategy: respects min profit and cooldown", async () => {
  const { db, client, portfolio, risk } = baseSetup();
  const arb = new FakeArbClient();
  arb.ticker = { bid: 100.05, ask: 100.1 };
  const gw = new FakeGateway();
  gw.best = { ask: 100, bid: 99.9 };
  const strategy = new ArbitrageStrategy(gw, client, portfolio, risk, arb, db, arbConfig({ minProfitPct: 0.5 }), {
    tradingActive: true,
    dryRun: true,
    feePct: 0.25,
  });
  await strategy.manage(pair);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, 0, "spread below min profit -> no trade");

  const arb2 = new FakeArbClient();
  arb2.ticker = { bid: 101, ask: 101.1 };
  const gw2 = new FakeGateway();
  gw2.best = { ask: 100, bid: 99.9 };
  const strategy2 = new ArbitrageStrategy(gw2, client, portfolio, risk, arb2, db, arbConfig({ cooldownMs: 60_000 }), {
    tradingActive: true,
    dryRun: true,
    feePct: 0.25,
  });
  await strategy2.manage(pair);
  const trades = db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length;
  assert.equal(trades, 2);
  await strategy2.manage(pair);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, trades, "cooldown blocks a second round trip");
});

test("arb strategy: live mode checks sell-side inventory before trading", async () => {
  const { db, client, portfolio, risk } = baseSetup();
  const arb = new FakeArbClient();
  arb.ticker = { bid: 101, ask: 101.1 };
  arb.balances.set("btc", 0);
  const gw = new FakeGateway();
  gw.best = { ask: 100, bid: 99.9 };
  const strategy = new ArbitrageStrategy(gw, client, portfolio, risk, arb, db, arbConfig(), {
    tradingActive: true,
    dryRun: false,
    feePct: 0.25,
  });
  await strategy.manage(pair);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, 0, "insufficient inventory on the sell side blocks the arb");
  assert.equal(arb.sells.length, 0);
  assert.equal(arb.buys.length, 0);
});

test("arb strategy: monitor-only mode records the opportunity but does not trade", async () => {
  const { db, client, portfolio, risk } = baseSetup();
  const arb = new FakeArbClient();
  arb.ticker = { bid: 101, ask: 101.1 };
  const gw = new FakeGateway();
  gw.best = { ask: 100, bid: 99.9 };
  const strategy = new ArbitrageStrategy(gw, client, portfolio, risk, arb, db, arbConfig(), {
    tradingActive: false,
    dryRun: true,
    feePct: 0.25,
  });
  await strategy.manage(pair);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, 0);
  assert.equal(db.getOrder(1), null);
  assert.equal(arb.sells.length, 0);
});

test("arb strategy: respects a risk halt", async () => {
  const { db, client, feed, portfolio, risk } = baseSetup();
  const arb = new FakeArbClient();
  arb.ticker = { bid: 101, ask: 101.1 };
  const gw = new FakeGateway();
  gw.best = { ask: 100, bid: 99.9 };
  const strategy = new ArbitrageStrategy(gw, client, portfolio, risk, arb, db, arbConfig(), {
    tradingActive: true,
    dryRun: true,
    feePct: 0.25,
    halted: () => risk.isHalted(),
  });
  risk.haltTrading("test halt");
  await strategy.manage(pair);
  assert.equal(db.tradesBetween("1970-01-01T00:00:00.000Z", "3000-01-01T00:00:00.000Z").length, 0);
});

test("BinanceArbClient: parses the public bookTicker and requires credentials for signed calls", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ bidPrice: "101.5", askPrice: "101.6" }), { status: 200 })) as typeof fetch;
  try {
    const client = new BinanceArbClient("https://api.binance.com", "", "");
    const ticker = await client.getTicker("btcusdt");
    assert.deepEqual(ticker, { bid: 101.5, ask: 101.6 });
    await assert.rejects(() => client.getBalance("btc"), /not configured/);
    await assert.rejects(() => client.marketBuy("btcusdt", 1), /not configured/);
  } finally {
    globalThis.fetch = original;
  }
});
