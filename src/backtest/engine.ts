import { AuditDb } from "../db.js";
import { BotConfig } from "../config.js";
import { NobitexClient } from "../exchange/nobitex.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { HybridStrategy } from "../strategy/hybrid.js";
import { SymbolPair, SentimentInput } from "../types.js";
import { BacktestBar } from "./data.js";

export interface BacktestTrade {
  ts: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  amount: number;
  total: number;
  fee: number;
  reason: string;
}

export interface BacktestRoundTrip {
  symbol: string;
  openTs: string;
  closeTs: string;
  entryPrice: number;
  exitPrice: number;
  amount: number;
  realizedPnl: number;
  fee: number;
  reason: string;
}

export interface BacktestMetrics {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  bars: number;
  fills: number;
  buys: number;
  sells: number;
  roundTrips: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  roundTrips: BacktestRoundTrip[];
  equityCurve: { ts: number; equity: number }[];
}

export interface RunBacktestArgs {
  config: BotConfig;
  pair: SymbolPair;
  bars: BacktestBar[];
  sentimentEvents: SentimentInput[];
  startEquity?: number;
}

export function runBacktest(args: RunBacktestArgs): BacktestResult {
  const { config, pair, bars } = args;
  const startEquity = args.startEquity ?? config.virtualStartEquity;
  const db = new AuditDb(":memory:");
  const client = new NobitexClient(config.nobitexBaseUrl, "");
  let virtualNow = bars.length > 0 ? bars[0]!.ts : Date.now();
  const now = (): number => virtualNow;

  const feed = new PriceFeed(client, [pair], config.seriesMaxPoints, false);
  const sentiment = new SentimentEngine(db, config.sentimentWindowMs, config.sentimentHalfLifeMs, config.sentimentMinConfidence, now);
  const portfolio = new PortfolioManager(db, client, feed, [pair], config.quoteCurrency, true, startEquity, now);
  const risk = new RiskManager(
    db,
    feed,
    portfolio,
    {
      maxPositionSizePct: config.maxPositionSizePct,
      maxTotalExposurePct: config.maxTotalExposurePct,
      maxDailyLossPct: config.maxDailyLossPct,
      maxTradesPerDay: config.maxTradesPerDay,
      minOrderValue: config.minOrderValue,
      volatilityMax: config.volatilityMax,
      volatilityBenchmark: config.volatilityBenchmark,
      volatilitySizeCap: config.volatilitySizeCap,
      cooldownMinutes: config.cooldownMinutes,
      rsiPeriod: config.rsiPeriod,
      rsiEntryUpper: config.rsiEntryUpper,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      trailingStopPct: config.trailingStopPct,
      trailingStopActivatePct: config.trailingStopActivatePct,
      trailingTpPct: config.trailingTpPct,
      trailingTpActivatePct: config.trailingTpActivatePct,
    },
    now
  );
  const strategy = new HybridStrategy(
    db,
    feed,
    sentiment,
    portfolio,
    risk,
    {
      rsiPeriod: config.rsiPeriod,
      rsiOverbought: config.rsiOverbought,
      rsiEntryUpper: config.rsiEntryUpper,
      sentimentEntryThreshold: config.sentimentEntryThreshold,
      sentimentExitThreshold: config.sentimentExitThreshold,
    }
  );

  const sortedEvents = [...args.sentimentEvents].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  let eventIdx = 0;

  const trades: BacktestTrade[] = [];
  const roundTrips: BacktestRoundTrip[] = [];
  const equityCurve: { ts: number; equity: number }[] = [];

  const initialEquity = portfolio.equity();
  let currentDay = "";
  let prevDayCloseEquity: number | null = null;

  for (const bar of bars) {
    const day = new Date(bar.ts).toISOString().slice(0, 10);
    if (day !== currentDay) {
      if (prevDayCloseEquity !== null) {
        db.setMeta("prev_day_equity", String(prevDayCloseEquity));
      }
      currentDay = day;
    }

    virtualNow = bar.ts;
    feed.pushPrice(pair.key, bar.close, bar.ts);
    while (eventIdx < sortedEvents.length && (sortedEvents[eventIdx]!.timestamp ?? 0) <= bar.ts) {
      sentiment.ingest(sortedEvents[eventIdx]!);
      eventIdx++;
    }

    const decision = strategy.evaluate(pair);

    if (decision.action === "BUY") {
      const fillPrice = decision.price ?? bar.close;
      const equity = portfolio.equity();
      const sizePct = decision.sizePct ?? config.maxPositionSizePct;
      const budget = equity * (sizePct / 100);
      const amount = budget / fillPrice;
      const ts = new Date(bar.ts).toISOString();
      const total = amount * fillPrice;
      const fee = total * (config.feePct / 100);
      db.insertTrade({ ts, orderId: null, symbol: pair.key, side: "buy", amount, price: fillPrice, total, fee });
      portfolio.applyTrade(pair, "buy", amount, fillPrice, fee, null);
      risk.recordTrade(pair);
      trades.push({ ts, symbol: pair.key, side: "buy", price: fillPrice, amount, total, fee, reason: decision.reason });
    } else if (decision.action === "SELL") {
      const pos = db.getOpenPosition(pair.key);
      if (pos) {
        const fillPrice = decision.price ?? bar.close;
        const amount = pos.amount;
        const ts = new Date(bar.ts).toISOString();
        const total = amount * fillPrice;
        const fee = total * (config.feePct / 100);
        const realized = (fillPrice - pos.entryPrice) * amount;
        db.insertTrade({ ts, orderId: null, symbol: pair.key, side: "sell", amount, price: fillPrice, total, fee });
        portfolio.applyTrade(pair, "sell", amount, fillPrice, fee, null);
        risk.recordTrade(pair);
        roundTrips.push({
          symbol: pair.key,
          openTs: pos.openTs,
          closeTs: ts,
          entryPrice: pos.entryPrice,
          exitPrice: fillPrice,
          amount,
          realizedPnl: realized - fee,
          fee,
          reason: decision.reason,
        });
        trades.push({ ts, symbol: pair.key, side: "sell", price: fillPrice, amount, total, fee, reason: decision.reason });
      }
    }

    const eq = portfolio.equity();
    equityCurve.push({ ts: bar.ts, equity: eq });
    prevDayCloseEquity = eq;
  }

  const endEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]!.equity : initialEquity;
  const wins = roundTrips.filter((t) => t.realizedPnl > 0);
  const losses = roundTrips.filter((t) => t.realizedPnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));

  let peak = initialEquity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const dd = (peak - point.equity) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const winSum = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const lossSum = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));

  const metrics: BacktestMetrics = {
    startEquity: initialEquity,
    endEquity,
    totalReturnPct: initialEquity > 0 ? ((endEquity - initialEquity) / initialEquity) * 100 : 0,
    bars: bars.length,
    fills: trades.length,
    buys: trades.filter((t) => t.side === "buy").length,
    sells: trades.filter((t) => t.side === "sell").length,
    roundTrips: roundTrips.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: roundTrips.length > 0 ? (wins.length / roundTrips.length) * 100 : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    maxDrawdownPct: maxDrawdown * 100,
    avgWinPct: wins.length > 0 ? (winSum / wins.length / initialEquity) * 100 : null,
    avgLossPct: losses.length > 0 ? (lossSum / losses.length / initialEquity) * 100 : null,
  };

  db.close();
  return { metrics, trades, roundTrips, equityCurve };
}
