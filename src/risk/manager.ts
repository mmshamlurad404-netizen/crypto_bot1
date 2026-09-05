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
  trailingStopPct: number;
  trailingStopActivatePct: number;
  trailingTpPct: number;
  trailingTpActivatePct: number;
  rsiShortEntryFloor?: number;
  marginStopLossPct?: number;
  marginTakeProfitPct?: number;
}

export interface TrailingCheck {
  hit: boolean;
  reason: string | null;
  kind: "trailing_stop" | "trailing_tp" | null;
  stopArmed: boolean;
  tpArmed: boolean;
}

interface TrailingState {
  positionId: number;
  peak: number;
  stopArmed: boolean;
  tpArmed: boolean;
}

interface MarginTrailingState {
  positionId: number;
  trough: number;
  stopArmed: boolean;
  tpArmed: boolean;
}

interface PersistedHalt {
  reason: string;
  ts: number;
  kind: "daily_loss" | "trigger";
}

interface PersistedRiskState {
  version: 1;
  halted: PersistedHalt | null;
  cooldown: [string, number][];
  trailing: { key: string; positionId: number; peak: number; stopArmed: boolean; tpArmed: boolean }[];
  marginTrailing: { key: string; positionId: number; trough: number; stopArmed: boolean; tpArmed: boolean }[];
}

const RISK_STATE_KEY = "risk.state_v1";

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class RiskManager {
  private db: AuditDb;
  private priceFeed: PriceFeed;
  private portfolio: PortfolioManager;
  private config: RiskConfigShape;
  private now: () => number;
  private lastTradeAt: Map<string, number> = new Map();
  private tradingHalted: string | null = null;
  private trailing: Map<string, TrailingState> = new Map();
  private marginTrailing: Map<string, MarginTrailingState> = new Map();

  constructor(db: AuditDb, priceFeed: PriceFeed, portfolio: PortfolioManager, config: RiskConfigShape, now: () => number = Date.now) {
    this.db = db;
    this.priceFeed = priceFeed;
    this.portfolio = portfolio;
    this.config = {
      ...config,
      rsiShortEntryFloor: config.rsiShortEntryFloor ?? 65,
      marginStopLossPct: config.marginStopLossPct ?? config.stopLossPct,
      marginTakeProfitPct: config.marginTakeProfitPct ?? config.takeProfitPct,
    };
    this.now = now;
    this.restore();
  }

  private persist(): void {
    const state: PersistedRiskState = {
      version: 1,
      halted: this.haltMeta,
      cooldown: [...this.lastTradeAt.entries()],
      trailing: [...this.trailing.entries()].map(([key, t]) => ({ key, ...t })),
      marginTrailing: [...this.marginTrailing.entries()].map(([key, t]) => ({ key, ...t })),
    };
    try {
      this.db.setMetaJSON(RISK_STATE_KEY, state);
    } catch {
      // persistence must never take down a tick
    }
  }

  private haltMeta: PersistedHalt | null = null;

  restore(): void {
    const saved = this.db.getMetaJSON<PersistedRiskState>(RISK_STATE_KEY);
    if (!saved || saved.version !== 1) return;
    this.lastTradeAt = new Map(saved.cooldown ?? []);
    this.trailing = new Map((saved.trailing ?? []).map((t) => [t.key, { positionId: t.positionId, peak: t.peak, stopArmed: t.stopArmed, tpArmed: t.tpArmed }]));
    this.marginTrailing = new Map(
      (saved.marginTrailing ?? []).map((t) => [t.key, { positionId: t.positionId, trough: t.trough, stopArmed: t.stopArmed, tpArmed: t.tpArmed }])
    );
    if (saved.halted) {
      const sameDay = utcDay(saved.halted.ts) === utcDay(this.now());
      if (!sameDay && saved.halted.kind === "daily_loss") {
        this.logEvent(null, "halt-cleared", "new day: daily-loss halt cleared on restart", { ts: saved.halted.ts });
        return;
      }
      this.haltMeta = saved.halted;
      this.tradingHalted = saved.halted.reason;
      this.logEvent(null, "halt-restored", `trading halt restored after restart: ${saved.halted.reason}`, { ts: saved.halted.ts, kind: saved.halted.kind });
    }
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

  private hasOpenMarginPosition(pair: SymbolPair): boolean {
    return this.db.getOpenMarginPosition(pair.key) !== null;
  }

  private hasAnyOpenPosition(pair: SymbolPair): boolean {
    return this.hasOpenPosition(pair) || this.hasOpenMarginPosition(pair);
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

  evaluateBuy(pair: SymbolPair, orderValueInQuote: number, volatility: number | null, rsi: number | null, options: { skipRsiGate?: boolean } = {}): RiskVerdict {
    return this.gates(pair, orderValueInQuote, volatility, rsi, false, options.skipRsiGate ?? false, "long");
  }

  evaluateDca(pair: SymbolPair, orderValueInQuote: number, volatility: number | null, rsi: number | null): RiskVerdict {
    return this.gates(pair, orderValueInQuote, volatility, rsi, true, false, "long");
  }

  evaluateShort(pair: SymbolPair, orderValueInQuote: number, volatility: number | null, rsi: number | null, options: { skipRsiGate?: boolean } = {}): RiskVerdict {
    return this.gates(pair, orderValueInQuote, volatility, rsi, false, options.skipRsiGate ?? false, "short");
  }

  private gates(
    pair: SymbolPair,
    orderValueInQuote: number,
    volatility: number | null,
    rsi: number | null,
    skipOpenPosition: boolean,
    skipRsiGate: boolean,
    direction: "long" | "short"
  ): RiskVerdict {
    const equity = this.portfolio.equity();
    const state = this.portfolio.state();

    if (this.tradingHalted) {
      return { allowed: false, reason: `trading halted: ${this.tradingHalted}`, halted: true, sizePct: 0 };
    }

    if (!this.db.getMeta("prev_day_equity") && this.db.latestSnapshot()) {
      this.db.setMeta("prev_day_equity", String(this.db.latestSnapshot()!.equity));
    }

    if (!skipOpenPosition && this.hasAnyOpenPosition(pair)) {
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
      this.haltMeta = { reason: msg, ts: this.now(), kind: "daily_loss" };
      this.logEvent(null, "halt-daily-loss", msg, { equity, prevEquity });
      this.persist();
      return { allowed: false, reason: `trading halted: ${msg}`, halted: true, sizePct: 0 };
    }

    if (this.dailyTradeCount() >= this.config.maxTradesPerDay) {
      const msg = `daily trade limit (${this.config.maxTradesPerDay}) reached`;
      this.logEvent(null, "blocked-trade-limit", msg, { tradesToday: this.dailyTradeCount() });
      return { allowed: false, reason: msg, halted: false, sizePct: 0 };
    }

    if (!skipRsiGate) {
      if (direction === "long") {
        if (rsi !== null && rsi > this.config.rsiEntryUpper) {
          const msg = `RSI ${rsi.toFixed(1)} above entry ceiling ${this.config.rsiEntryUpper}`;
          return { allowed: false, reason: msg, halted: false, sizePct: 0 };
        }
      } else {
        if (rsi === null || rsi < this.config.rsiShortEntryFloor!) {
          const msg = `RSI ${rsi === null ? "n/a" : rsi.toFixed(1)} below short entry floor ${this.config.rsiShortEntryFloor}`;
          return { allowed: false, reason: msg, halted: false, sizePct: 0 };
        }
      }
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

  checkTrailingStops(pair: SymbolPair, price: number): TrailingCheck {
    const pos = this.db.getOpenPosition(pair.key);
    if (!pos) {
      if (this.trailing.has(pair.key)) {
        this.trailing.delete(pair.key);
        this.persist();
      }
      return { hit: false, reason: null, kind: null, stopArmed: false, tpArmed: false };
    }
    let st = this.trailing.get(pair.key);
    let dirty = false;
    if (!st || st.positionId !== pos.id) {
      st = { positionId: pos.id, peak: pos.entryPrice, stopArmed: false, tpArmed: false };
      this.trailing.set(pair.key, st);
      dirty = true;
    }
    if (price > st.peak) {
      st.peak = price;
      dirty = true;
    }

    const trailStopPct = this.config.trailingStopPct;
    if (!st.stopArmed && trailStopPct > 0 && price >= pos.entryPrice * (1 + this.config.trailingStopActivatePct / 100)) {
      st.stopArmed = true;
      dirty = true;
    }
    if (st.stopArmed && trailStopPct > 0) {
      const trailStop = st.peak * (1 - trailStopPct / 100);
      if (price <= trailStop) {
        if (dirty) this.persist();
        return {
          hit: true,
          reason: `trailing stop ${trailStopPct}% (peak ${st.peak})`,
          kind: "trailing_stop",
          stopArmed: true,
          tpArmed: st.tpArmed,
        };
      }
    }

    const trailTpPct = this.config.trailingTpPct;
    if (!st.tpArmed && trailTpPct > 0 && price >= pos.entryPrice * (1 + this.config.trailingTpActivatePct / 100)) {
      st.tpArmed = true;
      dirty = true;
    }
    if (st.tpArmed && trailTpPct > 0) {
      const trailTp = st.peak * (1 - trailTpPct / 100);
      if (price <= trailTp) {
        if (dirty) this.persist();
        return {
          hit: true,
          reason: `trailing take-profit ${trailTpPct}% (peak ${st.peak})`,
          kind: "trailing_tp",
          stopArmed: st.stopArmed,
          tpArmed: true,
        };
      }
    }

    if (dirty) this.persist();
    return { hit: false, reason: null, kind: null, stopArmed: st.stopArmed, tpArmed: st.tpArmed };
  }

  recordTrade(pair: SymbolPair): void {
    this.lastTradeAt.set(pair.key, this.now());
    this.persist();
  }

  checkMarginStopLoss(pair: SymbolPair, price: number): { hit: boolean; reason: string | null } {
    const pos = this.db.getOpenMarginPosition(pair.key);
    if (!pos) return { hit: false, reason: null };
    const stopPrice = pos.entryPrice * (1 + this.config.marginStopLossPct! / 100);
    if (price >= stopPrice) {
      return { hit: true, reason: `margin stop-loss ${this.config.marginStopLossPct}%` };
    }
    return { hit: false, reason: null };
  }

  checkMarginTakeProfit(pair: SymbolPair, price: number): { hit: boolean; reason: string | null } {
    const pos = this.db.getOpenMarginPosition(pair.key);
    if (!pos) return { hit: false, reason: null };
    const tpPrice = pos.entryPrice * (1 - this.config.marginTakeProfitPct! / 100);
    if (price <= tpPrice) {
      return { hit: true, reason: `margin take-profit ${this.config.marginTakeProfitPct}%` };
    }
    return { hit: false, reason: null };
  }

  checkMarginTrailingStops(pair: SymbolPair, price: number): TrailingCheck {
    const pos = this.db.getOpenMarginPosition(pair.key);
    if (!pos) {
      if (this.marginTrailing.has(pair.key)) {
        this.marginTrailing.delete(pair.key);
        this.persist();
      }
      return { hit: false, reason: null, kind: null, stopArmed: false, tpArmed: false };
    }
    let st = this.marginTrailing.get(pair.key);
    let dirty = false;
    if (!st || st.positionId !== pos.id) {
      st = { positionId: pos.id, trough: pos.entryPrice, stopArmed: false, tpArmed: false };
      this.marginTrailing.set(pair.key, st);
      dirty = true;
    }
    if (price < st.trough) {
      st.trough = price;
      dirty = true;
    }

    const trailStopPct = this.config.trailingStopPct;
    if (!st.stopArmed && trailStopPct > 0 && price <= pos.entryPrice * (1 - this.config.trailingStopActivatePct / 100)) {
      st.stopArmed = true;
      dirty = true;
    }
    if (st.stopArmed && trailStopPct > 0) {
      const trailStop = st.trough * (1 + trailStopPct / 100);
      if (price >= trailStop) {
        if (dirty) this.persist();
        return {
          hit: true,
          reason: `margin trailing stop ${trailStopPct}% (trough ${st.trough})`,
          kind: "trailing_stop",
          stopArmed: true,
          tpArmed: st.tpArmed,
        };
      }
    }

    const trailTpPct = this.config.trailingTpPct;
    if (!st.tpArmed && trailTpPct > 0 && price <= pos.entryPrice * (1 - this.config.trailingTpActivatePct / 100)) {
      st.tpArmed = true;
      dirty = true;
    }
    if (st.tpArmed && trailTpPct > 0) {
      const trailTp = st.trough * (1 + trailTpPct / 100);
      if (price >= trailTp) {
        if (dirty) this.persist();
        return {
          hit: true,
          reason: `margin trailing take-profit ${trailTpPct}% (trough ${st.trough})`,
          kind: "trailing_tp",
          stopArmed: st.stopArmed,
          tpArmed: true,
        };
      }
    }

    if (dirty) this.persist();
    return { hit: false, reason: null, kind: null, stopArmed: st.stopArmed, tpArmed: st.tpArmed };
  }

  haltTrading(reason: string): void {
    this.tradingHalted = reason;
    this.haltMeta = { reason, ts: this.now(), kind: "trigger" };
    this.logEvent(null, "halt-trigger", reason, null);
    this.persist();
  }

  isHalted(): boolean {
    return this.tradingHalted !== null;
  }
}
