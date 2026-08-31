import { AuditDb } from "../db.js";
import { NobitexClient } from "../exchange/nobitex.js";
import { PriceFeed } from "../market/priceFeed.js";
import { SymbolPair, PortfolioState, WalletBalance, PositionWithValue, MarginPositionWithValue, QuoteCurrency } from "../types.js";

export class PortfolioManager {
  private db: AuditDb;
  private client: NobitexClient;
  private priceFeed: PriceFeed;
  private symbols: SymbolPair[];
  private quote: QuoteCurrency;
  private dryRun: boolean;
  private virtualStartEquity: number;
  private holdings: Map<string, number> = new Map();
  private wallets: WalletBalance[] = [];
  private realizedToday = 0;
  private now: () => number;

  constructor(
    db: AuditDb,
    client: NobitexClient,
    priceFeed: PriceFeed,
    symbols: SymbolPair[],
    quote: QuoteCurrency,
    dryRun: boolean,
    virtualStartEquity: number,
    now: () => number = Date.now
  ) {
    this.db = db;
    this.client = client;
    this.priceFeed = priceFeed;
    this.symbols = symbols;
    this.quote = quote;
    this.dryRun = dryRun;
    this.virtualStartEquity = virtualStartEquity;
    this.now = now;
    this.seedHoldings();
  }

  private seedHoldings(): void {
    if (!this.dryRun) return;
    if (this.holdings.size === 0) {
      this.holdings.set(this.quote, this.virtualStartEquity);
    }
  }

  async refresh(): Promise<void> {
    if (!this.dryRun) {
      this.wallets = await this.client.wallets();
      this.holdings = new Map();
      for (const w of this.wallets) {
        this.holdings.set(w.currency.toLowerCase(), w.activeBalance);
      }
    } else {
      this.seedHoldings();
    }
    this.realizedToday = this.loadRealizedToday();
  }

  private loadRealizedToday(): number {
    const dayKey = this.dayKey(new Date(this.now()));
    const v = this.db.getMeta(`day:${dayKey}:realized_pnl`);
    return v ? Number(v) : 0;
  }

  getHoldings(): Map<string, number> {
    return new Map(this.holdings);
  }

  getBalance(currency: string): number {
    return this.holdings.get(currency.toLowerCase()) ?? 0;
  }

  private priceOf(currency: string): number | null {
    if (currency === this.quote) return 1;
    const pair = this.symbols.find((s) => s.src === currency && s.dst === this.quote);
    if (!pair) return null;
    return this.priceFeed.getLatestPrice(pair.key);
  }

  equity(): number {
    let total = 0;
    for (const [currency, balance] of this.holdings) {
      const price = this.priceOf(currency);
      if (price === null) continue;
      total += balance * price;
    }
    return total + this.marginUnrealizedPnl();
  }

  marginPositionsWithValue(): MarginPositionWithValue[] {
    const positions = this.db.openMarginPositions();
    const result: MarginPositionWithValue[] = [];
    for (const pos of positions) {
      const price = this.priceFeed.getLatestPrice(pos.symbol);
      if (price === null) continue;
      const marketValue = pos.amount * price;
      const unrealizedPnl = (pos.entryPrice - price) * pos.amount;
      result.push({ ...pos, marketValue, unrealizedPnl });
    }
    return result;
  }

  totalMarginPositionsValue(): number {
    return this.marginPositionsWithValue().reduce((a, p) => a + p.marketValue, 0);
  }

  private marginUnrealizedPnl(): number {
    return this.marginPositionsWithValue().reduce((a, p) => a + p.unrealizedPnl, 0);
  }

  positionValue(pair: SymbolPair): number {
    const pos = this.db.getOpenPosition(pair.key);
    if (!pos) return 0;
    const price = this.priceFeed.getLatestPrice(pair.key);
    if (price === null) return 0;
    return pos.amount * price;
  }

  totalPositionsValue(): number {
    let total = 0;
    for (const pair of this.symbols) {
      total += this.positionValue(pair);
    }
    return total;
  }

  openPositionsWithValue(): PositionWithValue[] {
    const positions = this.db.openPositions();
    const result: PositionWithValue[] = [];
    for (const pos of positions) {
      const price = this.priceFeed.getLatestPrice(pos.symbol);
      if (price === null) continue;
      const marketValue = pos.amount * price;
      const unrealizedPnl = (price - pos.entryPrice) * pos.amount;
      result.push({ ...pos, marketValue, unrealizedPnl });
    }
    return result;
  }

  state(): PortfolioState {
    const equity = this.equity();
    const positions = this.openPositionsWithValue();
    const marginPositions = this.marginPositionsWithValue();
    const positionsValue = this.totalPositionsValue() + this.totalMarginPositionsValue();
    const unrealizedPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0) + marginPositions.reduce((a, p) => a + p.unrealizedPnl, 0);
    const cash = this.getBalance(this.quote);
    return {
      equity,
      cash,
      positionsValue,
      unrealizedPnl,
      realizedPnlToday: this.realizedToday,
      positions,
      marginPositions,
      holdings: this.getHoldings(),
    };
  }

  applyTrade(pair: SymbolPair, side: "buy" | "sell", amount: number, price: number, fee: number, orderId: number | null): void {
    const gross = amount * price;
    if (side === "buy") {
      this.holdings.set(pair.src, (this.getBalance(pair.src) ?? 0) + amount);
      this.holdings.set(pair.dst, (this.getBalance(pair.dst) ?? 0) - gross - fee);
      const existing = this.db.getOpenPosition(pair.key);
      if (existing) {
        const newAmount = existing.amount + amount;
        const newEntry = (existing.entryPrice * existing.amount + gross) / newAmount;
        this.db.updatePositionAmount(existing.id, newAmount, newEntry);
      } else {
        this.db.insertPosition({ symbol: pair.key, openTs: new Date(this.now()).toISOString(), entryPrice: price, amount, orderId });
      }
    } else {
      const pos = this.db.getOpenPosition(pair.key);
      this.holdings.set(pair.src, (this.getBalance(pair.src) ?? 0) - amount);
      this.holdings.set(pair.dst, (this.getBalance(pair.dst) ?? 0) + gross - fee);
      if (pos) {
        const realized = (price - pos.entryPrice) * amount;
        const remaining = pos.amount - amount;
        if (remaining <= 1e-12) {
          this.db.closePosition(pos.id, new Date(this.now()).toISOString(), price, realized, "sold");
        } else {
          this.db.closePosition(pos.id, new Date(this.now()).toISOString(), price, realized, "partial-sold");
          this.db.insertPosition({ symbol: pair.key, openTs: new Date(this.now()).toISOString(), entryPrice: price, amount: remaining, orderId });
        }
        this.realizedToday += realized;
        this.db.setMeta(`day:${this.dayKey(new Date(this.now()))}:realized_pnl`, String(this.realizedToday));
      }
    }
  }

  applyMarginOpen(pair: SymbolPair, amount: number, price: number, fee: number, orderId: number | null, leverage: number): void {
    this.db.insertMarginPosition({
      symbol: pair.key,
      openTs: new Date(this.now()).toISOString(),
      entryPrice: price,
      amount,
      leverage,
      orderId,
    });
  }

  applyMarginClose(pair: SymbolPair, amount: number, price: number, fee: number, orderId: number | null): void {
    const pos = this.db.getOpenMarginPosition(pair.key);
    if (!pos) return;
    const realized = (pos.entryPrice - price) * Math.min(amount, pos.amount);
    this.db.closeMarginPosition(pos.id, new Date(this.now()).toISOString(), price, realized, "covered");
    this.holdings.set(pair.dst, (this.getBalance(pair.dst) ?? 0) + realized);
    this.realizedToday += realized;
    this.db.setMeta(`day:${this.dayKey(new Date(this.now()))}:realized_pnl`, String(this.realizedToday));
  }

  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
