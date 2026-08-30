import { AuditDb } from "../db.js";
import { computeIndicators, calculateSMA, calculateEMA } from "../indicators.js";
import { PriceFeed } from "../market/priceFeed.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { RiskManager } from "../risk/manager.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { SymbolPair, SignalDecision, Position } from "../types.js";
import { StrategyConfigShape } from "./hybrid.js";
import { StrategyLike } from "../config/pools.js";

export interface LlmAdvice {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  rationale: string;
}

export interface LlmClient {
  advise(context: string): Promise<LlmAdvice>;
}

export interface AiAdvisorConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  minIntervalMs: number;
  contextBars: number;
}

const SYSTEM_PROMPT =
  "You are a conservative crypto trading advisor. Given a JSON market snapshot, reply with ONLY a single JSON object " +
  'of the form {"action":"BUY"|"SELL"|"HOLD","confidence":<0..1>,"rationale":"<short reason>"}. ' +
  "Prefer HOLD when unsure. Never recommend buying with all-in size; the bot applies its own risk limits.";

export function parseAdvice(content: string): LlmAdvice {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("LLM response contained no JSON object");
  let parsed: { action?: string; confidence?: number; rationale?: string };
  try {
    parsed = JSON.parse(match[0]) as { action?: string; confidence?: number; rationale?: string };
  } catch (err) {
    throw new Error(`LLM response was not valid JSON: ${(err as Error).message}`);
  }
  const action = String(parsed.action ?? "").toUpperCase();
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") {
    throw new Error(`LLM returned unsupported action "${parsed.action}"`);
  }
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
  return { action, confidence, rationale: String(parsed.rationale ?? "") };
}

export class HttpLlmClient implements LlmClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, apiKey: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
  }

  async advise(context: string): Promise<LlmAdvice> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: context },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content ?? "";
    return parseAdvice(content);
  }
}

export interface AiAdvisorOptions {
  contextBars?: number;
  minIntervalMs?: number;
  now?: () => number;
}

export class AiAdvisorStrategy implements StrategyLike {
  private db: AuditDb;
  private priceFeed: PriceFeed;
  private sentiment: SentimentEngine;
  private portfolio: PortfolioManager;
  private risk: RiskManager;
  private config: StrategyConfigShape;
  private llm: LlmClient;
  private contextBars: number;
  private minIntervalMs: number;
  private now: () => number;
  private lastCall = 0;

  constructor(
    db: AuditDb,
    priceFeed: PriceFeed,
    sentiment: SentimentEngine,
    portfolio: PortfolioManager,
    risk: RiskManager,
    config: StrategyConfigShape,
    llm: LlmClient,
    options: AiAdvisorOptions = {}
  ) {
    this.db = db;
    this.priceFeed = priceFeed;
    this.sentiment = sentiment;
    this.portfolio = portfolio;
    this.risk = risk;
    this.config = config;
    this.llm = llm;
    this.contextBars = options.contextBars ?? 40;
    this.minIntervalMs = options.minIntervalMs ?? 5 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  private hold(pair: SymbolPair, rsi: number | null, sentiment: number | null, price: number | null, reason: string): SignalDecision {
    return { symbol: pair.key, action: "HOLD", rsi, sentiment, price, reason };
  }

  private buildContext(
    pair: SymbolPair,
    closes: number[],
    rsi: number | null,
    volatility: number | null,
    price: number,
    sentiment: { score: number; count: number },
    openPos: Position | null
  ): string {
    const window = closes.slice(-this.contextBars);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    const ema20 = calculateEMA(closes, 20);
    const hi = Math.max(...window);
    const lo = Math.min(...window);
    return JSON.stringify({
      symbol: pair.key,
      price,
      lastBars: window,
      high: hi,
      low: lo,
      rsi: rsi !== null ? Number(rsi.toFixed(2)) : null,
      volatility: volatility !== null ? Number(volatility.toFixed(4)) : null,
      sma20: sma20 !== null ? Number(sma20.toFixed(2)) : null,
      sma50: sma50 !== null ? Number(sma50.toFixed(2)) : null,
      ema20: ema20 !== null ? Number(ema20.toFixed(2)) : null,
      sentimentScore: Number(sentiment.score.toFixed(3)),
      sentimentSources: sentiment.count,
      position: openPos
        ? { entryPrice: openPos.entryPrice, amount: openPos.amount, unrealizedPct: Number((((price - openPos.entryPrice) / openPos.entryPrice) * 100).toFixed(2)) }
        : null,
      riskLimits: { maxPositionSizePct: this.risk.sizeByVolatility(volatility) },
    });
  }

  async evaluate(pair: SymbolPair): Promise<SignalDecision> {
    const closes = this.priceFeed.getCloses(pair.key);
    const { rsi, volatility, price } = computeIndicators(closes, this.config.rsiPeriod);
    const priceNow = price ?? this.priceFeed.getLatestPrice(pair.key);
    const sentSnap = this.sentiment.snapshot(pair.src);

    if (closes.length < this.config.rsiPeriod + 5 || rsi === null || priceNow === null) {
      return this.hold(pair, rsi, sentSnap.score, priceNow, `warming up (${closes.length}/${this.config.rsiPeriod + 5} samples)`);
    }

    const openPos = this.db.getOpenPosition(pair.key);

    if (this.now() - this.lastCall < this.minIntervalMs) {
      return this.hold(pair, rsi, sentSnap.score, priceNow, "ai advisor throttled");
    }
    this.lastCall = this.now();

    let advice: LlmAdvice;
    try {
      advice = await this.llm.advise(this.buildContext(pair, closes, rsi, volatility, priceNow, sentSnap, openPos));
    } catch (err) {
      return this.hold(pair, rsi, sentSnap.score, priceNow, `ai advisor error: ${(err as Error).message}`);
    }

    if (advice.action === "SELL") {
      if (!openPos) {
        return this.hold(pair, rsi, sentSnap.score, priceNow, "ai sell ignored: no open position");
      }
      return { symbol: pair.key, action: "SELL", rsi, sentiment: sentSnap.score, price: priceNow, reason: `ai (${advice.rationale})` };
    }

    if (advice.action === "BUY") {
      if (openPos) {
        return this.hold(pair, rsi, sentSnap.score, priceNow, "ai buy ignored: position already open");
      }
      const sizePct = this.risk.sizeByVolatility(volatility);
      const orderValue = this.portfolio.equity() * (sizePct / 100);
      const verdict = this.risk.evaluateBuy(pair, orderValue, volatility, rsi, { skipRsiGate: true });
      if (!verdict.allowed) {
        return this.hold(pair, rsi, sentSnap.score, priceNow, `ai buy blocked: ${verdict.reason}`);
      }
      return {
        symbol: pair.key,
        action: "BUY",
        rsi,
        sentiment: sentSnap.score,
        price: priceNow,
        reason: `ai conf ${advice.confidence} (${advice.rationale})`,
        sizePct: verdict.sizePct || sizePct,
      };
    }

    return this.hold(pair, rsi, sentSnap.score, priceNow, `ai holds (${advice.rationale})`);
  }
}
