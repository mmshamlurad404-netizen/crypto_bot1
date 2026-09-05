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

export interface RecoveryReport {
  checked: number;
  filled: number;
  canceled: number;
  failed: number;
  stillNew: number;
  skippedMode: number;
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
    if (this.dryRun || !order.nobitexOrderId) {
      this.db.updateOrderStatus(orderId, "canceled", order.nobitexOrderId, null);
      this.logger.info({ orderId, symbol: order.symbol, dryRun: this.dryRun }, "limit order canceled");
      return true;
    }
    let resp: { status: string; updatedStatus?: string; order?: Record<string, unknown>; code?: string; message?: string } | null = null;
    try {
      resp = await this.client.cancelOrder(Number(order.nobitexOrderId));
    } catch (err) {
      this.logger.error({ orderId, error: (err as Error).message }, "cancel order request failed");
      return false;
    }
    if (resp.status !== "ok") {
      this.logger.error({ orderId, code: resp.code, message: resp.message }, "cancel order rejected by exchange");
      return false;
    }
    const matched = Number(resp.order?.matchedAmount ?? 0);
    if (matched > 0) {
      this.logger.info(
        { orderId, matched, symbol: order.symbol },
        "cancel raced a fill: partial matchedAmount kept resting until the next poll books it"
      );
      return false;
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
      let resp = await this.client.orderStatus({ id: Number(order.nobitexOrderId) });
      if ((resp.status !== "ok" || !resp.order) && order.clientOrderId) {
        this.logger.warn({ orderId: order.id }, "order status by id unavailable; retrying by clientOrderId");
        resp = await this.client.orderStatus({ clientOrderId: order.clientOrderId });
      }
      if (resp.status !== "ok" || !resp.order) {
        this.logger.warn({ orderId: order.id }, "live order status unavailable (order not found)");
        return { status: "new" };
      }
      const status = String(resp.order.status ?? "");
      const matched = Number(resp.order.matchedAmount ?? 0);
      const avg = Number(resp.order.averagePrice ?? 0);
      const fillPrice = avg > 0 ? avg : order.price ?? 0;
      const fullyMatched = matched >= order.amount - 1e-12;
      if (status === "Done" || status === "Filled" || (status !== "Canceled" && status !== "Cancelled" && fullyMatched)) {
        const filledAmount = matched > 0 ? Math.min(matched, order.amount) : order.amount;
        this.applyLimitFill(order.id, fillPrice, filledAmount);
        return { status: "filled", fillPrice, filledAmount };
      }
      if (status === "Canceled" || status === "Cancelled") {
        if (matched > 0) {
          this.applyLimitFill(order.id, fillPrice, matched);
          return { status: "filled", fillPrice, filledAmount: matched };
        }
        this.db.updateOrderStatus(order.id, "canceled", order.nobitexOrderId, null);
        return { status: "canceled" };
      }
      if (matched > 0) {
        this.logger.debug({ orderId: order.id, matched, status }, "limit order partially filled; booking deferred until a terminal status");
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

  async recoverLiveOrders(): Promise<RecoveryReport> {
    const report: RecoveryReport = { checked: 0, filled: 0, canceled: 0, failed: 0, stillNew: 0, skippedMode: 0 };
    for (const order of this.db.openOrders()) {
      if (order.dryRun !== this.dryRun) {
        this.logger.warn({ orderId: order.id, orderDryRun: order.dryRun, currentModeDryRun: this.dryRun }, "boot recovery skipped order from a different run mode");
        report.skippedMode++;
        continue;
      }
      report.checked++;
      const res = await this.poll(order.id);
      if (res.status === "filled") report.filled++;
      else if (res.status === "canceled") report.canceled++;
      else if (res.status === "failed") report.failed++;
      else report.stillNew++;
    }
    if (report.checked > 0) {
      this.logger.info({ report }, "boot recovery finished");
    }
    return report;
  }
}
