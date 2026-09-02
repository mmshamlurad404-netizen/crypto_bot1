import { randomBytes } from "node:crypto";
import type { AuditDb } from "../db.js";
import type { OrderGateway } from "../execution/gateway.js";
import type { NobitexClient } from "../exchange/nobitex.js";
import type { ArbExchangeClient } from "../exchange/arb.js";
import type { PortfolioManager } from "../portfolio/manager.js";
import type { RiskManager } from "../risk/manager.js";
import type { StrategyLike } from "../config/pools.js";
import type { SignalDecision, SymbolPair } from "../types.js";

export interface ArbStrategyConfig {
  enabled: boolean;
  exchange: string;
  symbols: Record<string, string>;
  fxRate: number;
  minProfitPct: number;
  maxNotionalPct: number;
  cooldownMs: number;
}

export interface ArbOptions {
  tradingActive: boolean;
  dryRun: boolean;
  feePct: number;
  halted?: () => boolean;
  now?: () => number;
}

interface Direction {
  buyNobitex: boolean;
  buyPrice: number;
  sellPrice: number;
  profitPct: number;
}

export class ArbitrageStrategy implements StrategyLike {
  private gateway: OrderGateway;
  private client: NobitexClient;
  private portfolio: PortfolioManager;
  private risk: RiskManager;
  private arbClient: ArbExchangeClient;
  private db: AuditDb;
  private config: ArbStrategyConfig;
  private tradingActive: boolean;
  private dryRun: boolean;
  private feePct: number;
  private halted: () => boolean;
  private now: () => number;
  private lastAt: Map<string, number> = new Map();

  constructor(
    gateway: OrderGateway,
    client: NobitexClient,
    portfolio: PortfolioManager,
    risk: RiskManager,
    arbClient: ArbExchangeClient,
    db: AuditDb,
    config: ArbStrategyConfig,
    options: ArbOptions
  ) {
    this.gateway = gateway;
    this.client = client;
    this.portfolio = portfolio;
    this.risk = risk;
    this.arbClient = arbClient;
    this.db = db;
    this.config = config;
    this.tradingActive = options.tradingActive;
    this.dryRun = options.dryRun;
    this.feePct = options.feePct;
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
      reason: "cross-exchange arbitrage active (managed per tick)",
    };
  }

  private clientOrderId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  }

  private roundAmount(amount: number): string {
    return amount.toFixed(8).replace(/\.?0+$/, "");
  }

  async manage(pair: SymbolPair): Promise<void> {
    const arbSymbol = this.config.symbols[pair.key];
    if (!arbSymbol) return;
    if (this.halted()) return;

    const now = this.now();
    const last = this.lastAt.get(pair.key);
    if (last !== undefined && now - last < this.config.cooldownMs) return;

    const nbx = this.gateway.getBestPrices(pair);
    if (nbx.ask === null || nbx.bid === null || nbx.ask <= 0 || nbx.bid <= 0) return;

    const arb = await this.arbClient.getTicker(arbSymbol);
    if (!arb || arb.bid <= 0 || arb.ask <= 0) return;

    const fx = this.config.fxRate > 0 ? this.config.fxRate : 1;
    const arbAsk = arb.ask * fx;
    const arbBid = arb.bid * fx;

    const costA = nbx.ask * (1 + this.feePct / 100);
    const proceedA = arbBid * (1 - this.feePct / 100);
    const profitPctA = costA > 0 ? ((proceedA - costA) / costA) * 100 : Number.NEGATIVE_INFINITY;

    const costB = arbAsk * (1 + this.feePct / 100);
    const proceedB = nbx.bid * (1 - this.feePct / 100);
    const profitPctB = costB > 0 ? ((proceedB - costB) / costB) * 100 : Number.NEGATIVE_INFINITY;

    const bestPct = Math.max(profitPctA, profitPctB);
    if (bestPct < this.config.minProfitPct) return;

    const buyNobitex = profitPctA >= profitPctB;
    const direction: Direction = {
      buyNobitex,
      buyPrice: buyNobitex ? nbx.ask : arbAsk,
      sellPrice: buyNobitex ? arbBid : nbx.bid,
      profitPct: bestPct,
    };

    const notional = this.portfolio.equity() * (this.config.maxNotionalPct / 100);
    const amount = notional / direction.buyPrice;
    if (amount <= 0) return;

    if (!this.dryRun) {
      const sellBase = buyNobitex ? await this.arbClient.getBalance(pair.src) : this.portfolio.getBalance(pair.src);
      if (sellBase < amount) {
        this.recordSignal(pair, direction, amount, `arb skipped: insufficient ${pair.src} on sell side`);
        return;
      }
    }

    this.lastAt.set(pair.key, now);
    this.recordSignal(pair, direction, amount, `arb ${this.arbClient.exchangeName} +${bestPct.toFixed(3)}%`);

    if (this.tradingActive) {
      await this.executeLegs(pair, arbSymbol, direction, amount);
    }
  }

  private async executeLegs(pair: SymbolPair, arbSymbol: string, direction: Direction, amount: number): Promise<void> {
    if (!this.dryRun) {
      if (direction.buyNobitex) {
        await this.nobitexMarket(pair, "buy", amount);
        await this.arbClient.marketSell(arbSymbol, amount);
      } else {
        await this.arbClient.marketBuy(arbSymbol, amount);
        await this.nobitexMarket(pair, "sell", amount);
      }
    }
    const feeBuy = direction.buyPrice * amount * (this.feePct / 100);
    const feeSell = direction.sellPrice * amount * (this.feePct / 100);
    const ts = new Date(this.now()).toISOString();
    this.db.insertOrder({
      ts,
      clientOrderId: this.clientOrderId("arb"),
      symbol: pair.key,
      side: "buy",
      execution: "market",
      amount,
      price: direction.buyPrice,
      status: "filled",
      dryRun: this.dryRun,
      nobitexOrderId: null,
      error: null,
      kind: "arb",
    });
    this.db.insertOrder({
      ts,
      clientOrderId: this.clientOrderId("arb"),
      symbol: pair.key,
      side: "sell",
      execution: "market",
      amount,
      price: direction.sellPrice,
      status: "filled",
      dryRun: this.dryRun,
      nobitexOrderId: null,
      error: null,
      kind: "arb",
    });
    this.db.insertTrade({ ts, orderId: null, symbol: pair.key, side: "buy", amount, price: direction.buyPrice, total: direction.buyPrice * amount, fee: feeBuy });
    this.db.insertTrade({ ts, orderId: null, symbol: pair.key, side: "sell", amount, price: direction.sellPrice, total: direction.sellPrice * amount, fee: feeSell });
    this.portfolio.applyArbRoundTrip(pair, amount, direction.buyPrice, direction.sellPrice, feeBuy, feeSell);
    this.risk.recordTrade(pair);
  }

  private async nobitexMarket(pair: SymbolPair, side: "buy" | "sell", amount: number): Promise<void> {
    const resp = await this.client.addOrder({
      type: side,
      execution: "market",
      srcCurrency: pair.src,
      dstCurrency: pair.dst,
      amount: this.roundAmount(amount),
      clientOrderId: this.clientOrderId("arb"),
    });
    if (resp.status !== "ok") {
      throw new Error(`arb nobitex ${side} leg failed: ${resp.message ?? resp.code}`);
    }
  }

  private recordSignal(pair: SymbolPair, direction: Direction, amount: number, reason: string): void {
    this.db.insertSignal({
      ts: new Date(this.now()).toISOString(),
      symbol: pair.key,
      action: direction.buyNobitex ? "BUY" : "SELL",
      rsi: null,
      sentiment: null,
      price: direction.buyPrice,
      seriesLen: null,
      reason,
      details: JSON.stringify({
        buyNobitex: direction.buyNobitex,
        buyPrice: direction.buyPrice,
        sellPrice: direction.sellPrice,
        profitPct: direction.profitPct,
        amount,
      }),
    });
  }
}
