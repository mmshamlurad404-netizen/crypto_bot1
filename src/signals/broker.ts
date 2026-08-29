export type SignalKind = "sentiment" | "trade";
export type SignalAction = "BUY" | "SELL";
export type SignalSource = "sentiment-webhook" | "sentiment-feed" | "tradingview" | "manual" | "scheduled";

export interface SignalIntent {
  source: SignalSource;
  kind: SignalKind;
  symbol: string;
  account?: string;
  sentiment?: number;
  confidence?: number;
  action?: SignalAction;
  price?: number | null;
  receivedAt: string;
  raw?: string | null;
}

export interface TradeIntent {
  source: SignalSource;
  symbol: string;
  action: SignalAction;
  price: number | null;
  receivedAt: string;
  raw?: string | null;
}

export interface SubmitResult {
  accepted: boolean;
  error: string | null;
  result?: unknown;
}

export class SignalBroker {
  private sentimentHandler: ((intent: SignalIntent) => unknown) | null = null;
  private queues = new Map<string, TradeIntent[]>();
  private capacity = 200;
  private submitted = 0;
  private rejected = 0;

  onSentiment(handler: (intent: SignalIntent) => unknown): void {
    this.sentimentHandler = handler;
  }

  submit(intent: SignalIntent): SubmitResult {
    this.submitted++;
    if (intent.kind === "sentiment") {
      if (typeof intent.sentiment !== "number") {
        this.rejected++;
        return { accepted: false, error: "sentiment intent missing a numeric sentiment" };
      }
      const result = this.sentimentHandler?.(intent);
      return { accepted: true, error: null, result };
    }
    if (intent.kind === "trade") {
      if (intent.action !== "BUY" && intent.action !== "SELL") {
        this.rejected++;
        return { accepted: false, error: `trade intent needs a BUY/SELL action, got "${intent.action ?? ""}"` };
      }
      const trade: TradeIntent = {
        source: intent.source,
        symbol: intent.symbol,
        action: intent.action,
        price: intent.price ?? null,
        receivedAt: intent.receivedAt,
        raw: intent.raw ?? null,
      };
      let q = this.queues.get(trade.symbol);
      if (!q) {
        q = [];
        this.queues.set(trade.symbol, q);
      }
      q.push(trade);
      if (q.length > this.capacity) {
        q.splice(0, q.length - this.capacity);
        this.rejected++;
      }
      return { accepted: true, error: null };
    }
    this.rejected++;
    return { accepted: false, error: `unknown intent kind "${intent.kind}"` };
  }

  shiftTrade(symbol: string): TradeIntent | null {
    const q = this.queues.get(symbol);
    const item = q ? q.shift() ?? null : null;
    if (q && q.length === 0) this.queues.delete(symbol);
    return item;
  }

  pendingTrades(symbol: string): number {
    return this.queues.get(symbol)?.length ?? 0;
  }

  totalPendingTrades(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  stats(): { submitted: number; rejected: number } {
    return { submitted: this.submitted, rejected: this.rejected };
  }
}
