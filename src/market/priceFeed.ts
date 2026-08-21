import { NobitexClient } from "../exchange/nobitex.js";
import { SymbolPair, PricePoint, MarketStat } from "../types.js";

export class PriceFeed {
  private client: NobitexClient;
  private symbols: SymbolPair[];
  private series: Map<string, PricePoint[]>;
  private maxPoints: number;
  private lastStats: Map<string, MarketStat>;

  constructor(client: NobitexClient, symbols: SymbolPair[], maxPoints: number, seedFromTrades: boolean) {
    this.client = client;
    this.symbols = symbols;
    this.series = new Map();
    this.lastStats = new Map();
    this.maxPoints = maxPoints;
    for (const s of symbols) this.series.set(s.key, []);
    if (seedFromTrades) this.seed().catch(() => undefined);
  }

  private async seed(): Promise<void> {
    for (const pair of this.symbols) {
      try {
        const trades = await this.client.recentTrades(this.udfSymbol(pair));
        const points = trades
          .map((t) => ({ ts: t.time, price: Number(t.price) }))
          .filter((p) => Number.isFinite(p.price) && p.price > 0)
          .sort((a, b) => a.ts - b.ts);
        const existing = this.series.get(pair.key)!;
        for (const p of points) this.append(pair.key, p.price, p.ts);
        if (existing.length > 0) {
          console.log(`[pricefeed] seeded ${pair.key} with ${points.length} points`);
        }
      } catch (err) {
        console.log(`[pricefeed] seed failed for ${pair.key}: ${(err as Error).message}`);
      }
    }
  }

  private udfSymbol(pair: SymbolPair): string {
    const dst = pair.dst === "rls" ? "irt" : pair.dst;
    return `${pair.src}${dst}`.toUpperCase();
  }

  private append(key: string, price: number, ts: number): void {
    const arr = this.series.get(key);
    if (!arr) return;
    const last = arr[arr.length - 1];
    if (last && last.ts === ts) {
      last.price = price;
      return;
    }
    arr.push({ ts, price });
    if (arr.length > this.maxPoints) {
      arr.splice(0, arr.length - this.maxPoints);
    }
  }

  pushPrice(key: string, price: number, ts = Date.now()): void {
    this.append(key, price, ts);
  }

  async poll(): Promise<void> {
    const srcCurrencies = [...new Set(this.symbols.map((s) => s.src))];
    const dstCurrencies = [...new Set(this.symbols.map((s) => s.dst))];
    const stats = await this.client.marketStats(srcCurrencies, dstCurrencies);
    for (const pair of this.symbols) {
      const stat = stats[pair.market.toLowerCase()] ?? stats[pair.market];
      if (!stat) continue;
      this.lastStats.set(pair.key, stat);
      const latest = Number(stat.latest);
      if (Number.isFinite(latest) && latest > 0) {
        this.append(pair.key, latest, Date.now());
      }
    }
  }

  getSeries(key: string): PricePoint[] {
    return this.series.get(key) ?? [];
  }

  getCloses(key: string): number[] {
    return this.getSeries(key).map((p) => p.price);
  }

  getLatestPrice(key: string): number | null {
    const arr = this.getSeries(key);
    return arr.length > 0 ? arr[arr.length - 1]!.price : null;
  }

  getBestPrices(key: string): { ask: number | null; bid: number | null } {
    const stat = this.lastStats.get(key);
    if (!stat) return { ask: null, bid: null };
    const ask = Number(stat.bestSell);
    const bid = Number(stat.bestBuy);
    return {
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
    };
  }

  getStat(key: string): MarketStat | null {
    return this.lastStats.get(key) ?? null;
  }
}
