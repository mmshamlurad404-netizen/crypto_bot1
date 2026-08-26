import { z } from "zod";
import { AuditDb } from "../db.js";
import { computeIndicators, calculateSMA, calculateEMA } from "../indicators.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { DcaLadder } from "./dca.js";
import { SymbolPair, SignalDecision } from "../types.js";

export type MaKind = "sma" | "ema";

export interface MaRef {
  kind: MaKind;
  period: number;
}

export type ConditionNode =
  | { rsi_lt: number }
  | { rsi_gt: number }
  | { volatility_lt: number }
  | { volatility_gt: number }
  | { sentiment_lt: number }
  | { sentiment_gt: number }
  | { price_gt_ma: MaRef }
  | { price_lt_ma: MaRef }
  | { and: ConditionNode[] }
  | { or: ConditionNode[] }
  | { not: ConditionNode };

export interface DslJson {
  warmupSamples?: number;
  entry?: ConditionNode;
  exit?: ConditionNode;
}

const maRefSchema = z.object({ kind: z.enum(["sma", "ema"]), period: z.number().int().positive() });

const nodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ rsi_lt: z.number() }),
    z.object({ rsi_gt: z.number() }),
    z.object({ volatility_lt: z.number() }),
    z.object({ volatility_gt: z.number() }),
    z.object({ sentiment_lt: z.number() }),
    z.object({ sentiment_gt: z.number() }),
    z.object({ price_gt_ma: maRefSchema }),
    z.object({ price_lt_ma: maRefSchema }),
    z.object({ and: z.array(nodeSchema) }),
    z.object({ or: z.array(nodeSchema) }),
    z.object({ not: nodeSchema }),
  ])
);

export const dslSchema = z.object({
  warmupSamples: z.number().int().positive().optional(),
  entry: nodeSchema.optional(),
  exit: nodeSchema.optional(),
});

export function parseDsl(json: unknown): DslJson {
  return dslSchema.parse(json);
}

interface EvalContext {
  price: number | null;
  rsi: number | null;
  volatility: number | null;
  sentiment: number | null;
  closes: number[];
}

export interface DslEvalInput extends EvalContext {}

function maValue(kind: MaKind, period: number, closes: number[]): number | null {
  return kind === "sma" ? calculateSMA(closes, period) : calculateEMA(closes, period);
}

export function evaluateNode(node: ConditionNode, ctx: EvalContext): boolean {
  if ("and" in node) return node.and.every((n) => evaluateNode(n, ctx));
  if ("or" in node) return node.or.some((n) => evaluateNode(n, ctx));
  if ("not" in node) return !evaluateNode(node.not, ctx);
  if ("rsi_lt" in node) return ctx.rsi !== null && ctx.rsi < node.rsi_lt;
  if ("rsi_gt" in node) return ctx.rsi !== null && ctx.rsi > node.rsi_gt;
  if ("volatility_lt" in node) return ctx.volatility !== null && ctx.volatility < node.volatility_lt;
  if ("volatility_gt" in node) return ctx.volatility !== null && ctx.volatility > node.volatility_gt;
  if ("sentiment_lt" in node) return ctx.sentiment !== null && ctx.sentiment < node.sentiment_lt;
  if ("sentiment_gt" in node) return ctx.sentiment !== null && ctx.sentiment > node.sentiment_gt;
  if ("price_gt_ma" in node) {
    const ma = maValue(node.price_gt_ma.kind, node.price_gt_ma.period, ctx.closes);
    return ctx.price !== null && ma !== null && ctx.price > ma;
  }
  if ("price_lt_ma" in node) {
    const ma = maValue(node.price_lt_ma.kind, node.price_lt_ma.period, ctx.closes);
    return ctx.price !== null && ma !== null && ctx.price < ma;
  }
  return false;
}

function maxMaPeriod(node: ConditionNode | undefined, acc = 0): number {
  if (!node) return acc;
  if ("and" in node) return node.and.reduce((a, n) => maxMaPeriod(n, a), acc);
  if ("or" in node) return node.or.reduce((a, n) => maxMaPeriod(n, a), acc);
  if ("not" in node) return maxMaPeriod(node.not, acc);
  if ("price_gt_ma" in node) return Math.max(acc, node.price_gt_ma.period);
  if ("price_lt_ma" in node) return Math.max(acc, node.price_lt_ma.period);
  return acc;
}

export class DslStrategy {
  private db: AuditDb;
  private priceFeed: PriceFeed;
  private sentiment: SentimentEngine;
  private portfolio: PortfolioManager;
  private risk: RiskManager;
  private rsiPeriod: number;
  private dsl: DslJson;
  private dca: DcaLadder;
  private requiredSamples: number;

  constructor(
    db: AuditDb,
    priceFeed: PriceFeed,
    sentiment: SentimentEngine,
    portfolio: PortfolioManager,
    risk: RiskManager,
    rsiPeriod: number,
    dsl: DslJson,
    dca: DcaLadder = new DcaLadder({ enabled: false, levels: [], maxOrders: 0 })
  ) {
    this.db = db;
    this.priceFeed = priceFeed;
    this.sentiment = sentiment;
    this.portfolio = portfolio;
    this.risk = risk;
    this.rsiPeriod = rsiPeriod;
    this.dsl = dsl;
    this.dca = dca;
    const maxMa = Math.max(maxMaPeriod(dsl.entry), maxMaPeriod(dsl.exit));
    this.requiredSamples = Math.max(rsiPeriod + 5, maxMa + 1, dsl.warmupSamples ?? 0);
  }

  evaluate(pair: SymbolPair): SignalDecision {
    const closes = this.priceFeed.getCloses(pair.key);
    const { rsi, volatility, price } = computeIndicators(closes, this.rsiPeriod);
    const sentSnap = this.sentiment.snapshot(pair.src);
    const sentiment = sentSnap.score;
    const priceNow = price ?? this.priceFeed.getLatestPrice(pair.key);

    if (closes.length < this.requiredSamples || priceNow === null) {
      return {
        symbol: pair.key,
        action: "HOLD",
        rsi,
        sentiment,
        price: priceNow,
        reason: `warming up (${closes.length}/${this.requiredSamples} samples)`,
      };
    }

    const ctx: EvalContext = { price: priceNow, rsi, volatility, sentiment, closes };
    const openPos = this.db.getOpenPosition(pair.key);

    if (openPos) {
      const sl = this.risk.checkStopLoss(pair, priceNow);
      if (sl.hit) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, sl.reason!);
      }
      const trail = this.risk.checkTrailingStops(pair, priceNow);
      if (trail.hit) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, trail.reason!);
      }
      const tp = this.risk.checkTakeProfit(pair, priceNow);
      if (tp.hit && !trail.tpArmed) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, tp.reason!);
      }
      if (this.dsl.exit && evaluateNode(this.dsl.exit, ctx)) {
        return this.sellSignal(pair, rsi, sentiment, priceNow, "dsl exit rule met");
      }
      const dcaLevel = this.dca.peek(openPos.id, openPos.entryPrice, priceNow);
      if (dcaLevel) {
        const equity = this.portfolio.equity();
        const budget = equity * (dcaLevel.buyPct / 100);
        const amount = budget / priceNow;
        const orderValue = amount * priceNow;
        const verdict = this.risk.evaluateDca(pair, orderValue, volatility, rsi);
        if (verdict.allowed) {
          this.dca.consume(openPos.id);
          return {
            symbol: pair.key,
            action: "BUY",
            rsi,
            sentiment,
            price: priceNow,
            reason: `DCA: price ${priceNow} is ${dcaLevel.belowPct}% below avg entry, adding ${dcaLevel.buyPct}% of equity`,
            sizePct: dcaLevel.buyPct,
            dca: true,
          };
        }
        this.logSignal(pair, "HOLD", rsi, sentiment, priceNow, `DCA level ${dcaLevel.belowPct}% blocked: ${verdict.reason}`);
      }
      return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceNow, reason: "holding open position" };
    }

    if (this.dsl.entry && evaluateNode(this.dsl.entry, ctx)) {
      const sizePct = this.risk.sizeByVolatility(volatility);
      const equity = this.portfolio.equity();
      const budget = equity * (sizePct / 100);
      const amount = budget / priceNow;
      const orderValue = amount * priceNow;
      const verdict = this.risk.evaluateBuy(pair, orderValue, volatility, rsi, { skipRsiGate: true });
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
        reason: "dsl entry rule met",
        sizePct,
      };
    }

    return {
      symbol: pair.key,
      action: "HOLD",
      rsi,
      sentiment,
      price: priceNow,
      reason: this.dsl.entry ? "dsl entry rule not met" : "no dsl entry rule configured",
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
