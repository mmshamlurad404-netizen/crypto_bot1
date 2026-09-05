import { z } from "zod";
import { AuditDb } from "../db.js";
import { computeIndicators, computeRichIndicators, calculateSMA, calculateEMA, type RichIndicatorResult } from "../indicators.js";
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
  | { macd_hist_pct_lt: number }
  | { macd_hist_pct_gt: number }
  | { stoch_k_lt: number }
  | { stoch_k_gt: number }
  | { stoch_d_lt: number }
  | { stoch_d_gt: number }
  | { atr_pct_lt: number }
  | { atr_pct_gt: number }
  | { boll_pct_lt: number }
  | { boll_pct_gt: number }
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
    z.object({ macd_hist_pct_lt: z.number() }),
    z.object({ macd_hist_pct_gt: z.number() }),
    z.object({ stoch_k_lt: z.number() }),
    z.object({ stoch_k_gt: z.number() }),
    z.object({ stoch_d_lt: z.number() }),
    z.object({ stoch_d_gt: z.number() }),
    z.object({ atr_pct_lt: z.number() }),
    z.object({ atr_pct_gt: z.number() }),
    z.object({ boll_pct_lt: z.number() }),
    z.object({ boll_pct_gt: z.number() }),
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
  macdHistPct?: number | null;
  stochK?: number | null;
  stochD?: number | null;
  atrPct?: number | null;
  bollPct?: number | null;
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
  if ("macd_hist_pct_lt" in node) return ctx.macdHistPct !== null && ctx.macdHistPct !== undefined && ctx.macdHistPct < node.macd_hist_pct_lt;
  if ("macd_hist_pct_gt" in node) return ctx.macdHistPct !== null && ctx.macdHistPct !== undefined && ctx.macdHistPct > node.macd_hist_pct_gt;
  if ("stoch_k_lt" in node) return ctx.stochK !== null && ctx.stochK !== undefined && ctx.stochK < node.stoch_k_lt;
  if ("stoch_k_gt" in node) return ctx.stochK !== null && ctx.stochK !== undefined && ctx.stochK > node.stoch_k_gt;
  if ("stoch_d_lt" in node) return ctx.stochD !== null && ctx.stochD !== undefined && ctx.stochD < node.stoch_d_lt;
  if ("stoch_d_gt" in node) return ctx.stochD !== null && ctx.stochD !== undefined && ctx.stochD > node.stoch_d_gt;
  if ("atr_pct_lt" in node) return ctx.atrPct !== null && ctx.atrPct !== undefined && ctx.atrPct < node.atr_pct_lt;
  if ("atr_pct_gt" in node) return ctx.atrPct !== null && ctx.atrPct !== undefined && ctx.atrPct > node.atr_pct_gt;
  if ("boll_pct_lt" in node) return ctx.bollPct !== null && ctx.bollPct !== undefined && ctx.bollPct < node.boll_pct_lt;
  if ("boll_pct_gt" in node) return ctx.bollPct !== null && ctx.bollPct !== undefined && ctx.bollPct > node.boll_pct_gt;
  return false;
}

function hasAdvancedNodes(node: ConditionNode | undefined): boolean {
  if (!node) return false;
  if ("and" in node) return node.and.some((n) => hasAdvancedNodes(n));
  if ("or" in node) return node.or.some((n) => hasAdvancedNodes(n));
  if ("not" in node) return hasAdvancedNodes(node.not);
  return (
    "macd_hist_pct_lt" in node ||
    "macd_hist_pct_gt" in node ||
    "stoch_k_lt" in node ||
    "stoch_k_gt" in node ||
    "stoch_d_lt" in node ||
    "stoch_d_gt" in node ||
    "atr_pct_lt" in node ||
    "atr_pct_gt" in node ||
    "boll_pct_lt" in node ||
    "boll_pct_gt" in node
  );
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
  private hasAdvanced: boolean;

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
    this.hasAdvanced = hasAdvancedNodes(dsl.entry) || hasAdvancedNodes(dsl.exit);
    const maxMa = Math.max(maxMaPeriod(dsl.entry), maxMaPeriod(dsl.exit));
    this.requiredSamples = Math.max(rsiPeriod + 5, maxMa + 1, dsl.warmupSamples ?? 0, this.hasAdvanced ? 45 : 0);
  }

  evaluate(pair: SymbolPair): SignalDecision {
    const closes = this.priceFeed.getCloses(pair.key);
    const sentSnap = this.sentiment.snapshot(pair.src);
    const sentiment = sentSnap.score;
    const priceNow = this.priceFeed.getLatestPrice(pair.key);
    if (closes.length < this.requiredSamples || priceNow === null) {
      const base = computeIndicators(closes, this.rsiPeriod);
      return {
        symbol: pair.key,
        action: "HOLD",
        rsi: base.rsi,
        sentiment,
        price: base.price ?? priceNow,
        reason: `warming up (${closes.length}/${this.requiredSamples} samples)`,
      };
    }

    const rich = this.hasAdvanced ? computeRichIndicators(closes, this.rsiPeriod) : computeIndicators(closes, this.rsiPeriod);
    const { rsi, volatility, price } = rich;
    const priceCtx = price ?? priceNow;
    let macdHistPct: number | null = null;
    let stochK: number | null = null;
    let stochD: number | null = null;
    let atrPct: number | null = null;
    let bollPct: number | null = null;
    if (this.hasAdvanced && "macdHistPct" in rich) {
      const r = rich as RichIndicatorResult;
      macdHistPct = r.macdHistPct;
      stochK = r.stochK;
      stochD = r.stochD;
      atrPct = r.atrPct;
      if (priceCtx !== null && r.bollingerMiddle !== null && r.bollingerMiddle > 0) {
        bollPct = ((priceCtx - r.bollingerMiddle) / r.bollingerMiddle) * 100;
      }
    }
    const ctx: EvalContext = {
      price: priceCtx,
      rsi,
      volatility,
      sentiment,
      closes,
      macdHistPct,
      stochK,
      stochD,
      atrPct,
      bollPct,
    };
    const openPos = this.db.getOpenPosition(pair.key);

    if (openPos) {
      const sl = this.risk.checkStopLoss(pair, priceCtx);
      if (sl.hit) {
        return this.sellSignal(pair, rsi, sentiment, priceCtx, sl.reason!);
      }
      const trail = this.risk.checkTrailingStops(pair, priceCtx);
      if (trail.hit) {
        return this.sellSignal(pair, rsi, sentiment, priceCtx, trail.reason!);
      }
      const tp = this.risk.checkTakeProfit(pair, priceCtx);
      if (tp.hit && !trail.tpArmed) {
        return this.sellSignal(pair, rsi, sentiment, priceCtx, tp.reason!);
      }
      if (this.dsl.exit && evaluateNode(this.dsl.exit, ctx)) {
        return this.sellSignal(pair, rsi, sentiment, priceCtx, "dsl exit rule met");
      }
      const dcaLevel = this.dca.peek(openPos.id, openPos.entryPrice, priceCtx);
      if (dcaLevel) {
        const equity = this.portfolio.equity();
        const budget = equity * (dcaLevel.buyPct / 100);
        const amount = budget / priceCtx;
        const orderValue = amount * priceCtx;
        const verdict = this.risk.evaluateDca(pair, orderValue, volatility, rsi);
        if (verdict.allowed) {
          this.dca.consume(openPos.id);
          return {
            symbol: pair.key,
            action: "BUY",
            rsi,
            sentiment,
            price: priceCtx,
            reason: `DCA: price ${priceCtx} is ${dcaLevel.belowPct}% below avg entry, adding ${dcaLevel.buyPct}% of equity`,
            sizePct: dcaLevel.buyPct,
            dca: true,
          };
        }
        this.logSignal(pair, "HOLD", rsi, sentiment, priceCtx, `DCA level ${dcaLevel.belowPct}% blocked: ${verdict.reason}`);
      }
      return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceCtx, reason: "holding open position" };
    }

    if (this.dsl.entry && evaluateNode(this.dsl.entry, ctx)) {
      const sizePct = this.risk.sizeByVolatility(volatility);
      const equity = this.portfolio.equity();
      const budget = equity * (sizePct / 100);
      const amount = budget / priceCtx;
      const orderValue = amount * priceCtx;
      const verdict = this.risk.evaluateBuy(pair, orderValue, volatility, rsi, { skipRsiGate: true });
      if (!verdict.allowed) {
        this.logSignal(pair, "HOLD", rsi, sentiment, priceCtx, `risk blocked: ${verdict.reason}`);
        return { symbol: pair.key, action: "HOLD", rsi, sentiment, price: priceCtx, reason: `risk blocked: ${verdict.reason}`, sizePct };
      }
      return {
        symbol: pair.key,
        action: "BUY",
        rsi,
        sentiment,
        price: priceCtx,
        reason: "dsl entry rule met",
        sizePct,
      };
    }

    return {
      symbol: pair.key,
      action: "HOLD",
      rsi,
      sentiment,
      price: priceCtx,
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
