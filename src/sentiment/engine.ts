import { AuditDb } from "../db.js";
import { SentimentInput } from "../types.js";

export interface SentimentSnapshot {
  symbol: string;
  score: number;
  count: number;
  sources: string[];
  lastUpdate: number | null;
}

export class SentimentEngine {
  private db: AuditDb;
  private windowMs: number;
  private halfLifeMs: number;
  private minConfidence: number;
  private now: () => number;
  private events: SentimentInput[] = [];

  constructor(db: AuditDb, windowMs: number, halfLifeMs: number, minConfidence: number, now: () => number = Date.now) {
    this.db = db;
    this.windowMs = windowMs;
    this.halfLifeMs = halfLifeMs;
    this.minConfidence = minConfidence;
    this.now = now;
    this.loadHistory();
  }

  private loadHistory(): void {
    const rows = this.db.getSentimentEvents(this.windowMs);
    for (const row of rows) {
      this.events.push({
        account: row.account,
        symbol: row.symbol,
        sentiment: row.sentiment,
        confidence: row.confidence,
        note: row.note ?? undefined,
        timestamp: new Date(row.ts).getTime(),
      });
    }
  }

  ingest(input: SentimentInput): SentimentSnapshot {
    const sentiment = Math.max(-1, Math.min(1, input.sentiment));
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 1));
    const now = this.now();
    const event: SentimentInput = {
      account: input.account,
      symbol: input.symbol.toLowerCase(),
      sentiment,
      confidence,
      note: input.note,
      timestamp: input.timestamp ?? now,
    };
    this.events.push(event);
    this.db.insertSentimentEvent({
      ts: new Date(event.timestamp!).toISOString(),
      account: event.account,
      symbol: event.symbol,
      sentiment,
      confidence,
      note: event.note ?? null,
    });
    this.prune(now);
    return this.snapshot(event.symbol, now);
  }

  private prune(now: number): void {
    this.events = this.events.filter((e) => now - e.timestamp! <= this.windowMs);
    if (this.events.length > 5000) {
      this.events = this.events.slice(-5000);
    }
  }

  snapshot(symbol: string, now = this.now()): SentimentSnapshot {
    const relevant = this.events.filter(
      (e) =>
        e.symbol === symbol.toLowerCase() &&
        e.confidence! >= this.minConfidence &&
        now - e.timestamp! <= this.windowMs
    );
    if (relevant.length === 0) {
      return { symbol: symbol.toLowerCase(), score: 0, count: 0, sources: [], lastUpdate: null };
    }
    let weightSum = 0;
    let valueSum = 0;
    let lastUpdate = 0;
    const sources = new Set<string>();
    for (const e of relevant) {
      const age = now - e.timestamp!;
      const decay = Math.exp(-age / this.halfLifeMs);
      const w = e.confidence! * decay;
      weightSum += w;
      valueSum += w * e.sentiment!;
      sources.add(e.account);
      lastUpdate = Math.max(lastUpdate, e.timestamp!);
    }
    return {
      symbol: symbol.toLowerCase(),
      score: weightSum > 0 ? valueSum / weightSum : 0,
      count: relevant.length,
      sources: [...sources],
      lastUpdate: lastUpdate > 0 ? lastUpdate : null,
    };
  }

  allSymbols(): string[] {
    return [...new Set(this.events.map((e) => e.symbol))];
  }
}
