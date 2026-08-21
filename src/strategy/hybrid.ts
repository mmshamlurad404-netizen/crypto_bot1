import { AuditDb } from "../db.js";
import { computeIndicators } from "../indicators.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { SymbolPair, SignalDecision } from "../types.js";

export interface StrategyConfigShape {
  rsiPeriod: number;
  rsiOverbought: number;
  rsiEntryUpper: number;
  sentimentEntryThreshold: number;
  sentimentExitThreshold: number;
}

export class HybridStrategy {
  private db: AuditDb;
  private priceFeed: PriceFeed;
  private sentiment: SentimentEngine;
  private portfolio: PortfolioManager;
  private risk: RiskManager;
  private config: StrategyConfigShape;

  constructor(
    db: AuditDb,
    priceFeed: PriceFeed,
    sentiment: SentimentEngine,
    portfolio: PortfolioManager,
    risk: RiskManager,
    config: StrategyConfigShape
  ) {
    this.db = db;
    this.priceFeed = priceFeed;
    this.sentiment = sentiment;
    this.portfolio = portfolio;
    this.risk = risk;
    this.config = config;
  }

  evaluate(pair: SymbolPair): SignalDecision {
    const closes = this.priceFeed.getCloses(pair.key);
    const { rsi, volatility, price } = computeIndicators(closes, this.config.rsiPeriod);
    const sentSnap = this.sentiment.snapshot(pair.src);
    const sentiment = sentSnap.score;
    const sentimentCount = sentSnap.count;
    const priceNow = price ?? this.priceFeed.getLatestPrice(pair.key);

    if (closes.length < this.config.rsiPeriod + 5 || rsi === null || priceNow === null) {
      return {
        symbol: pair.key,
        action: "HOLD",
        rsi,
        sentiment,
        price: priceNow,
        reason: `warming up (${closes.length}/${this.config.rsiPeriod + 5} samples)`,
      };
    }

    const openPos = this.db.getOpenPosition(pair.key);

    if (openPos) {
      const sl = this.risk.checkStopLoss(pair, priceNow);
      if (sl.hit) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, sl.reason!);
      }
      const tp = this.risk.checkTakeProfit(pair, priceNow);
      if (tp.hit) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, tp.reason!);
      }
      if (sentimentCount > 0 && sentiment <= this.config.sentimentExitThreshold) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, `sentiment ${sentiment.toFixed(2)} <= ${this.config.sentimentExitThreshold}`);
      }
      if (rsi >= this.config.rsiOverbought) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, `RSI ${rsi.toFixed(1)} >= ${this.config.rsiOverbought} (overbought)`);
      }
      return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceNow, reason: "holding open position" };
    }

    const bullishSentiment = sentiment >= this.config.sentimentEntryThreshold;
    const oversoldDip = rsi < this.config.rsiEntryUpper;

    if (!bullishSentiment) {
      return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceNow, reason: `sentiment ${sentiment.toFixed(2)} below entry threshold ${this.config.sentimentEntryThreshold}` };
    }
    if (!oversoldDip) {
      return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceNow, reason: `RSI ${rsi.toFixed(1)} not below entry ceiling ${this.config.rsiEntryUpper}` };
    }

    const sizePct = this.risk.sizeByVolatility(volatility);
    const equity = this.portfolio.equity();
    const budget = equity * (sizePct / 100);
    const amount = budget / priceNow;
    const orderValue = amount * priceNow;

    const verdict = this.risk.evaluateBuy(pair, orderValue, volatility, rsi);
    if (!verdict.allowed) {
      this.logSignal(pair, "HOLD", rsi, sentiment, priceNow, `risk blocked: ${verdict.reason}`);
      return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceNow, reason: `risk blocked: ${verdict.reason}`, sizePct };
    }

    return {
      symbol: pair.key,
      action: "BUY",
      rsi,
      sentiment,
      price: priceNow,
      reason: `sentiment ${sentiment.toFixed(2)} bullish and RSI ${rsi.toFixed(1)} in dip zone`,
      sizePct,
    };
  }

  private sellSignal(pair: SymbolPair, rsi: number | null, sentiment: number, price: number, reason: string): SignalDecision {
    return { symbol: pair.key, action: "SELL", rsi, sentiment, price, reason };
  }

  private logSignal(pair: SymbolPair, action: string, rsi: number | null, sentiment: number, price: number | null, reason: string): void {
    this.db.insertSignal({
      ts: new Date().toISOString(),
      symbol: pair.key,
      action,
      rsi,
      sentiment,
      price,
      seriesLen: this.priceFeed.getSeries(pair.key).length,
      reason,
      details: null,
    });
  }
}
