import { AuditDb } from "../db.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SymbolPair } from "../types.js";
import { OrderGateway, PollResult, MarketResult } from "../execution/gateway.js";
import { BacktestBar } from "./data.js";

export class BacktestOrderGateway implements OrderGateway {
  private db: AuditDb;
  private priceFeed: PriceFeed;
  private portfolio: PortfolioManager;
  private risk: RiskManager;
  private feePct: number;
  private now: () => number;
  private bar: BacktestBar | null = null;
  private counter = 0;

  constructor(
    db: AuditDb,
    priceFeed: PriceFeed,
    portfolio: PortfolioManager,
    risk: RiskManager,
    feePct: number,
    now: () => number
  ) {
    this.db = db;
    this.priceFeed = priceFeed;
    this.portfolio = portfolio;
    this.risk = risk;
    this.feePct = feePct;
    this.now = now;
  }

  setBar(bar: BacktestBar | null): void {
    this.bar = bar;
  }

  getBestPrices(pair: SymbolPair): { ask: number | null; bid: number | null } {
    const bar = this.bar;
    if (!bar) return { ask: null, bid: null };
    return { ask: bar.high, bid: bar.low };
  }

  getLatestPrice(pair: SymbolPair): number | null {
    return this.priceFeed.getLatestPrice(pair.key);
  }

  getBalance(currency: string): number {
    return this.portfolio.getBalance(currency);
  }

  private pairFromKey(key: string): SymbolPair {
    const [src, dst] = key.split("/");
    return { src: src ?? "", dst: dst ?? "", key, market: `${src}-${dst}`.toUpperCase() };
  }

  private clientOrderId(): string {
    this.counter += 1;
    return `bt-${this.now()}-${this.counter}`;
  }

  async placeLimit(pair: SymbolPair, side: "buy" | "sell", amount: number, price: number, kind: string): Promise<number | null> {
    return this.db.insertOrder({
      ts: new Date(this.now()).toISOString(),
      clientOrderId: this.clientOrderId(),
      symbol: pair.key,
      side,
      execution: "limit",
      amount,
      price,
      status: "new",
      dryRun: true,
      nobitexOrderId: null,
      error: null,
      kind,
    });
  }

  async cancel(orderId: number): Promise<boolean> {
    const order = this.db.getOrder(orderId);
    if (!order || order.status !== "new") return false;
    this.db.updateOrderStatus(orderId, "canceled", null, null);
    return true;
  }

  async poll(orderId: number): Promise<PollResult> {
    const order = this.db.getOrder(orderId);
    if (!order) return { status: "failed" };
    if (order.status !== "new") return { status: order.status };
    const bar = this.bar;
    if (!bar) return { status: "new" };
    const limit = order.price ?? 0;
    let filled = false;
    if (order.side === "buy" && bar.low <= limit) filled = true;
    if (order.side === "sell" && bar.high >= limit) filled = true;
    if (!filled) return { status: "new" };
    const fillPrice = limit;
    const filledAmount = order.amount;
    this.applyFill(order.id, fillPrice, filledAmount);
    return { status: "filled", fillPrice, filledAmount };
  }

  async market(pair: SymbolPair, side: "buy" | "sell", amount: number, kind: string): Promise<MarketResult | null> {
    const bar = this.bar;
    const price = bar ? bar.close : this.priceFeed.getLatestPrice(pair.key);
    if (price === null || price <= 0 || amount <= 0) return null;
    this.applyMarket(pair, side, amount, price, kind);
    return { price, amount };
  }

  private applyFill(orderId: number, fillPrice: number, filledAmount: number): void {
    const order = this.db.getOrder(orderId);
    if (!order) return;
    const pair = this.pairFromKey(order.symbol);
    const ts = new Date(this.now()).toISOString();
    const total = filledAmount * fillPrice;
    const fee = total * (this.feePct / 100);
    this.db.updateOrderStatus(orderId, "filled", null, null);
    this.db.insertTrade({ ts, orderId, symbol: pair.key, side: order.side, amount: filledAmount, price: fillPrice, total, fee });
    this.portfolio.applyTrade(pair, order.side, filledAmount, fillPrice, fee, orderId);
    this.risk.recordTrade(pair);
  }

  private applyMarket(pair: SymbolPair, side: "buy" | "sell", amount: number, price: number, kind: string): void {
    const ts = new Date(this.now()).toISOString();
    const total = amount * price;
    const fee = total * (this.feePct / 100);
    const orderId = this.db.insertOrder({
      ts,
      clientOrderId: this.clientOrderId(),
      symbol: pair.key,
      side,
      execution: "market",
      amount,
      price,
      status: "filled",
      dryRun: true,
      nobitexOrderId: null,
      error: null,
      kind,
    });
    this.db.insertTrade({ ts, orderId, symbol: pair.key, side, amount, price, total, fee });
    this.portfolio.applyTrade(pair, side, amount, price, fee, orderId);
    this.risk.recordTrade(pair);
  }
}
