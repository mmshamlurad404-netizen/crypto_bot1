import type { AuditDb } from "../db.js";
import type { OrderGateway } from "../execution/gateway.js";
import type { StrategyLike } from "../config/pools.js";
import type { SignalDecision, SymbolPair } from "../types.js";

export interface MmStrategyConfig {
  enabled: boolean;
  symbols: string[];
  spreadPct: number;
  orderValue: number;
  maxInventoryValue: number;
  stopLossPct: number;
  cooldownMs: number;
  maxQuoteAgeMs: number;
  minOrderValue: number;
}

export interface MmOptions {
  tradingActive?: boolean;
  halted?: () => boolean;
  now?: () => number;
}

interface PairMmState {
  inventory: number;
  costBasis: number;
  bidOrderId: number | null;
  bidPlacedAt: number;
  askOrderId: number | null;
  askPlacedAt: number;
  lastFillAt: number;
}

const EPS = 1e-12;

export class MarketMakingStrategy implements StrategyLike {
  private gateway: OrderGateway;
  private db: AuditDb;
  private config: MmStrategyConfig;
  private tradingActive: boolean;
  private halted: () => boolean;
  private now: () => number;
  private states: Map<string, PairMmState> = new Map();

  constructor(gateway: OrderGateway, db: AuditDb, config: MmStrategyConfig, options: MmOptions = {}) {
    this.gateway = gateway;
    this.db = db;
    this.config = config;
    this.tradingActive = options.tradingActive ?? true;
    this.halted = options.halted ?? (() => false);
    this.now = options.now ?? Date.now;
  }

  evaluate(pair: SymbolPair): SignalDecision {
    return {
      symbol: pair.key,
      action: "HOLD",
      rsi: null,
      sentiment: null,
      price: this.gateway.getLatestPrice(pair),
      reason: "market making active (resting quotes managed per tick)",
    };
  }

  private enabledFor(pair: SymbolPair): boolean {
    if (!this.config.enabled) return false;
    return this.config.symbols.length === 0 || this.config.symbols.includes(pair.key);
  }

  private stateFor(pair: SymbolPair): PairMmState {
    let s = this.states.get(pair.key);
    if (!s) {
      s = { inventory: 0, costBasis: 0, bidOrderId: null, bidPlacedAt: 0, askOrderId: null, askPlacedAt: 0, lastFillAt: 0 };
      this.states.set(pair.key, s);
    }
    return s;
  }

  private midOf(pair: SymbolPair): number | null {
    const { ask, bid } = this.gateway.getBestPrices(pair);
    if (ask !== null && bid !== null && ask > 0 && bid > 0) return (ask + bid) / 2;
    return this.gateway.getLatestPrice(pair);
  }

  private log(pair: SymbolPair, action: string, reason: string, price: number | null, amount: number | null): void {
    this.db.insertSignal({
      ts: new Date(this.now()).toISOString(),
      symbol: pair.key,
      action,
      rsi: null,
      sentiment: null,
      price,
      seriesLen: null,
      reason,
      details: amount !== null ? JSON.stringify({ amount }) : null,
    });
  }

  private async pollOrders(pair: SymbolPair, state: PairMmState, now: number): Promise<void> {
    if (state.bidOrderId !== null) {
      const res = await this.gateway.poll(state.bidOrderId);
      if (res.status === "filled") {
        const amt = res.filledAmount ?? 0;
        const px = res.fillPrice ?? 0;
        const prev = state.inventory;
        state.inventory = prev + amt;
        state.costBasis = prev > 0 ? (state.costBasis * prev + px * amt) / state.inventory : px;
        state.bidOrderId = null;
        state.lastFillAt = now;
        this.log(pair, "BUY", "mm bid filled", px, amt);
      } else if (res.status === "canceled" || res.status === "failed") {
        state.bidOrderId = null;
      } else if (now - state.bidPlacedAt >= this.config.maxQuoteAgeMs) {
        const cancelled = await this.gateway.cancel(state.bidOrderId);
        if (cancelled) state.bidOrderId = null;
      }
    }
    if (state.askOrderId !== null) {
      const res = await this.gateway.poll(state.askOrderId);
      if (res.status === "filled") {
        const amt = res.filledAmount ?? 0;
        const px = res.fillPrice ?? 0;
        state.inventory = Math.max(0, state.inventory - amt);
        if (state.inventory <= EPS) {
          state.inventory = 0;
          state.costBasis = 0;
        }
        state.askOrderId = null;
        state.lastFillAt = now;
        this.log(pair, "SELL", "mm ask filled", px, amt);
      } else if (res.status === "canceled" || res.status === "failed") {
        state.askOrderId = null;
      } else if (now - state.askPlacedAt >= this.config.maxQuoteAgeMs) {
        const cancelled = await this.gateway.cancel(state.askOrderId);
        if (cancelled) state.askOrderId = null;
      }
    }
  }

  private async requote(pair: SymbolPair, state: PairMmState, now: number, bidPrice: number, bidAmount: number, askPrice: number, askAmount: number): Promise<void> {
    if (state.bidOrderId === null && bidAmount > 0 && bidAmount * bidPrice >= this.config.minOrderValue) {
      const id = await this.gateway.placeLimit(pair, "buy", bidAmount, this.round(bidPrice), "mm_bid");
      if (id !== null) {
        state.bidOrderId = id;
        state.bidPlacedAt = now;
      }
    }
    if (state.askOrderId === null && state.inventory > EPS && askAmount > 0 && askAmount * askPrice >= this.config.minOrderValue) {
      const id = await this.gateway.placeLimit(pair, "sell", askAmount, this.round(askPrice), "mm_ask");
      if (id !== null) {
        state.askOrderId = id;
        state.askPlacedAt = now;
      }
    }
  }

  private round(price: number): number {
    return Math.round(price * 1e8) / 1e8;
  }

  async manage(pair: SymbolPair): Promise<void> {
    if (!this.enabledFor(pair)) return;
    if (!this.tradingActive) {
      this.log(pair, "HOLD", "mm disabled: trading not active (dry-run off and TRADING_ENABLED off)", this.gateway.getLatestPrice(pair), null);
      return;
    }
    if (this.halted()) return;

    const state = this.stateFor(pair);
    const now = this.now();

    await this.pollOrders(pair, state, now);

    if (state.lastFillAt > 0 && now - state.lastFillAt < this.config.cooldownMs) return;

    const mid = this.midOf(pair);
    if (mid === null || mid <= 0) return;

    if (state.inventory > EPS && state.costBasis > 0 && mid < state.costBasis * (1 - this.config.stopLossPct / 100)) {
      const res = await this.gateway.market(pair, "sell", state.inventory, "mm_exit");
      if (res) {
        state.inventory = 0;
        state.costBasis = 0;
        state.lastFillAt = now;
        this.log(pair, "SELL", `mm stop-loss market close (cost ${state.costBasis})`, res.price, res.amount);
      }
      return;
    }

    const invValue = state.inventory * mid;
    const skew = Math.max(0, Math.min(1, this.config.maxInventoryValue > 0 ? invValue / this.config.maxInventoryValue : 0));
    const halfSpread = this.config.spreadPct / 200;
    const bidPrice = mid * (1 - halfSpread * (1 + skew));
    const askPrice = mid * (1 + halfSpread * (1 - skew));
    const maxBidAmount = this.config.maxInventoryValue > 0 ? Math.max(0, (this.config.maxInventoryValue - invValue) / mid) : Number.POSITIVE_INFINITY;
    const bidAmount = Math.min(this.config.orderValue / bidPrice, maxBidAmount);
    const askAmount = Math.min(this.config.orderValue / askPrice, state.inventory);

    await this.requote(pair, state, now, bidPrice, bidAmount, askPrice, askAmount);
  }
}
