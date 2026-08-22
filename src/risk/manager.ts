import { AuditDb } from "../db.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { SymbolPair } from "../types.js";

export interface RiskVerdict {
  allowed: boolean;
  reason: string | null;
  halted: boolean;
  sizePct: number;
}

export interface RiskConfigShape {
  maxPositionSizePct: number;
  maxTotalExposurePct: number;
  maxDailyLossPct: number;
  maxTradesPerDay: number;
  minOrderValue: number;
  volatilityMax: number;
  volatilityBenchmark: number;
  volatilitySizeCap: number;
  cooldownMinutes: number;
  rsiPeriod: number;
  rsiEntryUpper: number;
  stopLossPct: number;
  takeProfitPct: number;
}

export class RiskManager {
  private db: AuditDb;
  private priceFeed: PriceFeed;
  private portfolio: PortfolioManager;
  private config: RiskConfigShape;
  private now: () => number;
  private lastTradeAt: Map<string, number> = new Map();
  private tradingHalted: string | null = null;

  constructor(db: AuditDb, priceFeed: PriceFeed, portfolio: PortfolioManager, config: RiskConfigShape, now: () => number = Date.now) {
    this.db = db;
    this.priceFeed = priceFeed;
    this.portfolio = portfolio;
    this.config = config;
    this.now = now;
  }

  sizeByVolatility(volatility: number | null): number {
    if (volatility === null || volatility <= 0) return this.config.maxPositionSizePct;
    const ratio = this.config.volatilityBenchmark / volatility;
    const capped = Math.min(ratio, this.config.volatilitySizeCap);
    return Math.max(1, Math.min(this.config.maxPositionSizePct, this.config.maxPositionSizePct * capped));
  }

  private prevDayEquity(): number | null {
    const fromMeta = this.db.getMeta("prev_day_equity");
    if (fromMeta) return Number(fromMeta);
    const snap = this.db.latestSnapshot();
    return snap ? snap.equity : null;
  }

  private logEvent(symbol: string | null, kind: string, message: string, data: Record<string, unknown> | null): void {
    this.db.insertRiskEvent({
      ts: new Date(this.now()).toISOString(),
      symbol,
      kind,
      message,
      data: data ? JSON.stringify(data) : null,
    });
  }

  private hasOpenPosition(pair: SymbolPair): boolean {
    return this.db.getOpenPosition(pair.key) !== null;
  }

  private dailyTradeCount(): number {
    const dayStart = new Date(this.now()).toISOString().slice(0, 10);
    return this.db.countTradesToday(`${dayStart}T00:00:00.000Z`);
  }

  private cooldownActive(pair: SymbolPair): boolean {
    const last = this.lastTradeAt.get(pair.key);
    if (!last) return false;
    return this.now() - last < this.config.cooldownMinutes * 60 * 1000;
  }

  evaluateBuy(pair: SymbolPair, orderValueInQuote: number, volatility: number | null, rsi: number | null): RiskVerdict {
    const equity = this.portfolio.equity();
    const state = this.portfolio.state();

    if (this.tradingHalted) {
      return { allowed: false, reason: `trading halted: ${this.tradingHalted}`, halted: true, sizePct: 0 };
    }

    if (!this.db.getMeta("prev_day_equity") && this.db.latestSnapshot()) {
      this.db.setMeta("prev_day_equity", String(this.db.latestSnapshot()!.equity));
    }

    if (this.hasOpenPosition(pair)) {
      this.logEvent(pair.key, "blocked-position", "position already open", { symbol: pair.key });
      return { allowed: false, reason: "position already open for symbol", halted: false, sizePct: 0 };
    }

    if (this.cooldownActive(pair)) {
      this.logEvent(pair.key, "blocked-cooldown", "symbol in cooldown window", { symbol: pair.key });
      return { allowed: false, reason: "symbol in cooldown window", halted: false, sizePct: 0 };
    }

    if (volatility !== null && volatility > this.config.volatilityMax) {
      const msg = `volatility ${(volatility * 100).toFixed(2)}% exceeds max ${(this.config.volatilityMax * 100).toFixed(2)}%`;
      this.logEvent(pair.key, "blocked-volatility", msg, { symbol: pair.key, volatility });
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    if (orderValueInQuote < this.config.minOrderValue) {
      const msg = `order value ${orderValueInQuote} below minimum ${this.config.minOrderValue}`;
      this.logEvent(pair.key, "blocked-min-value", msg, { symbol: pair.key, orderValue: orderValueInQuote });
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    const sizePct = this.sizeByVolatility(volatility);
    const projectedPositionValue = state.positionsValue + orderValueInQuote;
    if (projectedPositionValue / equity > this.config.maxTotalExposurePct / 100) {
      const msg = `projected exposure ${((projectedPositionValue / equity) * 100).toFixed(1)}% exceeds max ${this.config.maxTotalExposurePct}%`;
      this.logEvent(pair.key, "blocked-exposure", msg, { symbol: pair.key, projectedExposure: projectedPositionValue / equity });
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    if (orderValueInQuote / equity > this.config.maxPositionSizePct / 100) {
      const msg = `order value ${((orderValueInQuote / equity) * 100).toFixed(1)}% of equity exceeds max position size ${this.config.maxPositionSizePct}%`;
      this.logEvent(pair.key, "blocked-position-size", msg, { symbol: pair.key, orderValue: orderValueInQuote, equity });
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    const prevEquity = this.prevDayEquity();
    if (prevEquity !== null && equity < prevEquity * (1 - this.config.maxDailyLossPct / 100)) {
      const msg = `daily loss ${((1 - equity / prevEquity) * 100).toFixed(2)}% exceeds max ${this.config.maxDailyLossPct}%`;
      this.tradingHalted = msg;
      this.logEvent(null, "halt-daily-loss", msg, { equity, prevEquity });
      return { allowed: false, reason: `trading halted: ${msg}`, halted: true, sizePct: 0 };
    }

    if (this.dailyTradeCount() >= this.config.maxTradesPerDay) {
      const msg = `daily trade limit (${this.config.maxTradesPerDay}) reached`;
      this.logEvent(null, "blocked-trade-limit", msg, { tradesToday: this.dailyTradeCount() });
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    if (rsi !== null && rsi > this.config.rsiEntryUpper) {
      const msg = `RSI ${rsi.toFixed(1)} above entry ceiling ${this.config.rsiEntryUpper}`;
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    return { allowed: true, reason: null, halted: false, sizePct };
  }

  checkStopLoss(pair: SymbolPair, price: number): { hit: boolean; reason: string | null } {
    const pos = this.db.getOpenPosition(pair.key);
    if (!pos) return { hit: false, reason: null };
    const stopPrice = pos.entryPrice * (1 - this.config.stopLossPct / 100);
    if (price <= stopPrice) {
      return { hit: true, reason: `stop-loss ${this.config.stopLossPct}%` };
    }
    return { hit: false, reason: null };
  }

  checkTakeProfit(pair: SymbolPair, price: number): { hit: boolean; reason: string | null } {
    const pos = this.db.getOpenPosition(pair.key);
    if (!pos) return { hit: false, reason: null };
    const tpPrice = pos.entryPrice * (1 + this.config.takeProfitPct / 100);
    if (price >= tpPrice) {
      return { hit: true, reason: `take-profit ${this.config.takeProfitPct}%` };
    }
    return { hit: false, reason: null };
  }

  recordTrade(pair: SymbolPair): void {
    this.lastTradeAt.set(pair.key, this.now());
  }
}
