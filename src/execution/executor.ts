import { randomBytes } from "node:crypto";
import { AuditDb } from "../db.js";
import { NobitexClient, NobitexError } from "../exchange/nobitex.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { OrderRecord, SymbolPair } from "../types.js";
import { pino, type Logger } from "pino";
import { OrderGateway, PollResult, MarketResult } from "./gateway.js";

export interface FillResult {
  orderId: number;
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  total: number;
  fee: number;
  simulated: boolean;
}

export function pairFromKey(key: string): SymbolPair {
  const [src, dst] = key.split("/");
  return { src: src ?? "", dst: dst ?? "", key, market: `${src}-${dst}`.toUpperCase() };
}

export class Executor implements OrderGateway {
  private db: AuditDb;
  private client: NobitexClient;
  private priceFeed: PriceFeed;
  private portfolio: PortfolioManager;
  private risk: RiskManager;
  private dryRun: boolean;
  private feePct: number;
  private logger: Logger;

  constructor(
    db: AuditDb,
    client: NobitexClient,
    priceFeed: PriceFeed,
    portfolio: PortfolioManager,
    risk: RiskManager,
    dryRun: boolean,
    feePct: number,
    logger: Logger
  ) {
    this.db = db;
    this.client = client;
    this.priceFeed = priceFeed;
    this.portfolio = portfolio;
    this.risk = risk;
    this.dryRun = dryRun;
    this.feePct = feePct;
    this.logger = logger;
  }

  private clientOrderId(): string {
    return `sb-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  }

  private roundAmount(amount: number): string {
    return amount.toFixed(8).replace(/\.?0+$/, "");
  }

  async buy(pair: SymbolPair, amount: number, kind: "entry" | "dca" = "entry"): Promise<FillResult | null> {
    return this.execute(pair, "buy", amount, kind, "spot");
  }

  async sell(pair: SymbolPair, amount: number): Promise<FillResult | null> {
    return this.execute(pair, "sell", amount, "exit", "spot");
  }

  async openShort(pair: SymbolPair, amount: number, leverage: number): Promise<FillResult | null> {
    return this.execute(pair, "sell", amount, "short_open", "margin", leverage);
  }

  async coverShort(pair: SymbolPair, amount: number): Promise<FillResult | null> {
    return this.execute(pair, "buy", amount, "short_cover", "margin");
  }

  private async execute(
    pair: SymbolPair,
    side: "buy" | "sell",
    amount: number,
    kind: string,
    mode: "spot" | "margin",
    leverage: number = 2
  ): Promise<FillResult | null> {
    const ts = new Date().toISOString();
    const clientOrderId = this.clientOrderId();

    const { ask, bid } = this.priceFeed.getBestPrices(pair.key);
    const fillPrice = side === "buy" ? ask ?? bid : bid ?? ask;
    if (fillPrice === null) {
      this.db.insertOrder({
        ts,
        clientOrderId,
        symbol: pair.key,
        side,
        execution: "market",
        amount,
        price: null,
        status: "failed",
        dryRun: this.dryRun,
        nobitexOrderId: null,
        error: "no market price available",
        kind,
      });
      this.logger.warn({ symbol: pair.key, side, mode }, "execution skipped: no price available");
      return null;
    }

    let nobitexOrderId: string | null = null;
    let error: string | null = null;
    let finalPrice = fillPrice;
    let filledAmount = amount;
    if (!this.dryRun) {
      try {
        const resp =
          mode === "margin"
            ? await this.client.marginAddOrder({
                type: side,
                execution: "market",
                srcCurrency: pair.src,
                dstCurrency: pair.dst,
                amount: this.roundAmount(amount),
                leverage,
                clientOrderId,
              })
            : await this.client.addOrder({
                type: side,
                execution: "market",
                srcCurrency: pair.src,
                dstCurrency: pair.dst,
                amount: this.roundAmount(amount),
                clientOrderId,
              });
        if (resp.status !== "ok" || !resp.order) {
          error = resp.message ?? resp.code ?? "order rejected";
          this.logger.error({ symbol: pair.key, side, mode, code: resp.code, message: resp.message }, "order rejected by exchange");
        } else {
          nobitexOrderId = String(resp.order.id);
          const matched = Number(resp.order.matchedAmount ?? 0);
          const avg = Number(resp.order.averagePrice ?? 0);
          if (matched > 0) {
            filledAmount = matched;
            if (avg > 0) finalPrice = avg;
            else {
              const mark = Number(resp.order.price);
              if (mark > 0) finalPrice = mark;
            }
          } else {
            const status = String(resp.order.status ?? "");
            if (status === "Active" || status === "New") {
              error = `order placed but not filled immediately (status ${status}), id=${nobitexOrderId}`;
            }
          }
        }
      } catch (err) {
        error = err instanceof NobitexError ? err.message : (err as Error).message;
        this.logger.error({ symbol: pair.key, side, mode, error }, "order request failed");
      }
    }

    const orderId = this.db.insertOrder({
      ts,
      clientOrderId,
      symbol: pair.key,
      side,
      execution: "market",
      amount,
      price: finalPrice,
      status: error ? "failed" : "filled",
      dryRun: this.dryRun,
      nobitexOrderId,
      error,
      kind,
    });

    if (error) {
      return null;
    }

    const total = filledAmount * finalPrice;
    const fee = total * (this.feePct / 100);
    this.db.insertTrade({
      ts: new Date().toISOString(),
      orderId,
      symbol: pair.key,
      side,
      amount: filledAmount,
      price: finalPrice,
      total,
      fee,
    });
    if (mode === "margin") {
      if (side === "sell") {
        this.portfolio.applyMarginOpen(pair, filledAmount, finalPrice, fee, orderId, leverage);
      } else {
        this.portfolio.applyMarginClose(pair, filledAmount, finalPrice, fee, orderId);
      }
    } else {
      this.portfolio.applyTrade(pair, side, filledAmount, finalPrice, fee, orderId);
    }
    this.risk.recordTrade(pair);

    this.logger.info(
      { symbol: pair.key, side, amount: filledAmount, price: finalPrice, total, fee, mode, dryRun: this.dryRun },
      "executed fill"
    );
    return { orderId, symbol: pair.key, side, amount: filledAmount, price: finalPrice, total, fee, simulated: this.dryRun };
  }

  getBestPrices(pair: SymbolPair): { ask: number | null; bid: number | null } {
    return this.priceFeed.getBestPrices(pair.key);
  }

  getLatestPrice(pair: SymbolPair): number | null {
    return this.priceFeed.getLatestPrice(pair.key);
  }

  getBalance(currency: string): number {
    return this.portfolio.getBalance(currency);
  }

  async placeLimit(pair: SymbolPair, side: "buy" | "sell", amount: number, price: number, kind: string): Promise<number | null> {
    const ts = new Date().toISOString();
    const clientOrderId = this.clientOrderId();
    let nobitexOrderId: string | null = null;
    let error: string | null = null;
    if (!this.dryRun) {
      try {
        const resp = await this.client.addOrder({
          type: side,
          execution: "limit",
          srcCurrency: pair.src,
          dstCurrency: pair.dst,
          amount: this.roundAmount(amount),
          price: this.roundAmount(price),
          clientOrderId,
        });
        if (resp.status !== "ok" || !resp.order) {
          error = resp.message ?? resp.code ?? "order rejected";
          this.logger.error({ symbol: pair.key, side, price, code: resp.code, message: resp.message }, "limit order rejected by exchange");
        } else {
          nobitexOrderId = String(resp.order.id);
          const status = String(resp.order.status ?? "");
          if (status === "Done" || status === "Filled") {
            error = `limit order filled immediately (status ${status}), id=${nobitexOrderId}`;
          }
        }
      } catch (err) {
        error = err instanceof NobitexError ? err.message : (err as Error).message;
        this.logger.error({ symbol: pair.key, side, price, error }, "limit order request failed");
      }
    }
    const orderId = this.db.insertOrder({
      ts,
      clientOrderId,
      symbol: pair.key,
      side,
      execution: "limit",
      amount,
      price,
      status: error ? "failed" : "new",
      dryRun: this.dryRun,
      nobitexOrderId,
      error,
      kind,
    });
    return error ? null : orderId;
  }

  async cancel(orderId: number): Promise<boolean> {
    const order = this.db.getOrder(orderId);
    if (!order || order.status !== "new") return false;
    if (!this.dryRun && order.nobitexOrderId) {
      try {
        await this.client.cancelOrder(Number(order.nobitexOrderId));
      } catch (err) {
        this.logger.error({ orderId, error: (err as Error).message }, "cancel order request failed");
      }
    }
    this.db.updateOrderStatus(orderId, "canceled", order.nobitexOrderId, null);
    this.logger.info({ orderId, symbol: order.symbol }, "limit order canceled");
    return true;
  }

  async poll(orderId: number): Promise<PollResult> {
    const order = this.db.getOrder(orderId);
    if (!order) return { status: "failed" };
    if (order.status === "filled") {
      return { status: "filled", fillPrice: order.price ?? undefined, filledAmount: order.amount };
    }
    if (order.status !== "new") {
      return { status: order.status };
    }
    if (this.dryRun) {
      return this.pollDryRun(order);
    }
    return this.pollLive(order);
  }

  private async pollDryRun(order: OrderRecord): Promise<PollResult> {
    const { ask, bid } = this.priceFeed.getBestPrices(order.symbol);
    const limit = order.price ?? 0;
    let filled = false;
    if (order.side === "buy" && ask !== null && ask <= limit) filled = true;
    if (order.side === "sell" && bid !== null && bid >= limit) filled = true;
    if (!filled) return { status: "new" };
    const fillPrice = limit;
    const filledAmount = order.amount;
    this.applyLimitFill(order.id, fillPrice, filledAmount);
    return { status: "filled", fillPrice, filledAmount };
  }

  private async pollLive(order: OrderRecord): Promise<PollResult> {
    if (!order.nobitexOrderId) return { status: "new" };
    try {
      const resp = await this.client.orderStatus({ id: Number(order.nobitexOrderId) });
      if (resp.status !== "ok" || !resp.order) return { status: "new" };
      const status = String(resp.order.status ?? "");
      const matched = Number(resp.order.matchedAmount ?? 0);
      if (status === "Done" || status === "Filled" || matched > 0) {
        const filledAmount = matched > 0 ? matched : order.amount;
        const avg = Number(resp.order.averagePrice ?? 0);
        const fillPrice = avg > 0 ? avg : order.price ?? 0;
        this.applyLimitFill(order.id, fillPrice, filledAmount);
        return { status: "filled", fillPrice, filledAmount };
      }
      if (status === "Canceled" || status === "Cancelled") {
        this.db.updateOrderStatus(order.id, "canceled", order.nobitexOrderId, null);
        return { status: "canceled" };
      }
      return { status: "new" };
    } catch (err) {
      this.logger.error({ orderId: order.id, error: (err as Error).message }, "order status poll failed");
      return { status: "new" };
    }
  }

  private applyLimitFill(orderId: number, fillPrice: number, filledAmount: number): void {
    const order = this.db.getOrder(orderId);
    if (!order) return;
    const total = filledAmount * fillPrice;
    const fee = total * (this.feePct / 100);
    const pair = pairFromKey(order.symbol);
    this.db.updateOrderStatus(orderId, "filled", order.nobitexOrderId, null);
    this.db.insertTrade({
      ts: new Date().toISOString(),
      orderId,
      symbol: pair.key,
      side: order.side,
      amount: filledAmount,
      price: fillPrice,
      total,
      fee,
    });
    this.portfolio.applyTrade(pair, order.side, filledAmount, fillPrice, fee, orderId);
    this.risk.recordTrade(pair);
    this.logger.info(
      { orderId, symbol: pair.key, side: order.side, amount: filledAmount, price: fillPrice, total, fee, dryRun: this.dryRun },
      "limit order filled"
    );
  }

  async market(pair: SymbolPair, side: "buy" | "sell", amount: number, kind: string): Promise<MarketResult | null> {
    const fill = await this.execute(pair, side, amount, kind, "spot");
    return fill ? { price: fill.price, amount: fill.amount } : null;
  }
}
