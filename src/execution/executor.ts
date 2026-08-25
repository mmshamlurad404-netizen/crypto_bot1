import { randomBytes } from "node:crypto";
import { AuditDb } from "../db.js";
import { NobitexClient, NobitexError } from "../exchange/nobitex.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SymbolPair } from "../types.js";
import { pino, type Logger } from "pino";

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

export class Executor {
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
    return this.execute(pair, "buy", amount, kind);
  }

  async sell(pair: SymbolPair, amount: number): Promise<FillResult | null> {
    return this.execute(pair, "sell", amount, "exit");
  }

  private async execute(pair: SymbolPair, side: "buy" | "sell", amount: number, kind: "entry" | "dca" | "exit" = "entry"): Promise<FillResult | null> {
    const ts = new Date().toISOString();
    const clientOrderId = this.clientOrderId();

    let fillPrice: number | null = null;
    if (this.dryRun) {
      const { ask, bid } = this.priceFeed.getBestPrices(pair.key);
      fillPrice = side === "buy" ? ask ?? bid : bid ?? ask;
    } else {
      const { ask, bid } = this.priceFeed.getBestPrices(pair.key);
      fillPrice = side === "buy" ? ask ?? bid : bid ?? ask;
    }
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
      this.logger.warn({ symbol: pair.key, side }, "execution skipped: no price available");
      return null;
    }

    let nobitexOrderId: string | null = null;
    let error: string | null = null;
    let finalPrice = fillPrice;
    let filledAmount = amount;
    if (!this.dryRun) {
      try {
        const resp = await this.client.addOrder({
          type: side,
          execution: "market",
          srcCurrency: pair.src,
          dstCurrency: pair.dst,
          amount: this.roundAmount(amount),
          clientOrderId,
        });
        if (resp.status !== "ok" || !resp.order) {
          error = resp.message ?? resp.code ?? "order rejected";
          this.logger.error({ symbol: pair.key, side, code: resp.code, message: resp.message }, "order rejected by exchange");
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
        this.logger.error({ symbol: pair.key, side, error }, "order request failed");
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
    this.portfolio.applyTrade(pair, side, filledAmount, finalPrice, fee, orderId);
    this.risk.recordTrade(pair);

    this.logger.info(
      { symbol: pair.key, side, amount: filledAmount, price: finalPrice, total, fee, dryRun: this.dryRun },
      "executed fill"
    );
    return { orderId, symbol: pair.key, side, amount: filledAmount, price: finalPrice, total, fee, simulated: this.dryRun };
  }
}
