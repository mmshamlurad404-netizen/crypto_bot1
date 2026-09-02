import { createHmac } from "node:crypto";

export interface ArbTicker {
  bid: number;
  ask: number;
}

export interface ArbExchangeClient {
  readonly exchangeName: string;
  getTicker(symbol: string): Promise<ArbTicker | null>;
  getBalance(asset: string): Promise<number>;
  marketBuy(symbol: string, amount: number): Promise<void>;
  marketSell(symbol: string, amount: number): Promise<void>;
}

export class BinanceArbClient implements ArbExchangeClient {
  readonly exchangeName = "binance";
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(baseUrl = "https://api.binance.com", apiKey = "", apiSecret = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async getTicker(symbol: string): Promise<ArbTicker | null> {
    const url = new URL(`${this.baseUrl}/api/v3/ticker/bookTicker`);
    url.searchParams.set("symbol", symbol.toUpperCase());
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { bidPrice?: string; askPrice?: string };
    const bid = Number(json.bidPrice);
    const ask = Number(json.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    return { bid, ask };
  }

  private signedQuery(): string {
    const timestamp = Date.now();
    const q = `timestamp=${timestamp}`;
    const sig = createHmac("sha256", this.apiSecret).update(q).digest("hex");
    return `${q}&signature=${sig}`;
  }

  private async authed(path: string): Promise<unknown> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error("BinanceArbClient: API key/secret not configured");
    }
    const url = `${this.baseUrl}${path}?${this.signedQuery()}`;
    const res = await fetch(url, { method: "GET", headers: { "X-MBX-APIKEY": this.apiKey }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`Binance account request failed with status ${res.status}`);
    }
    return res.json();
  }

  async getBalance(asset: string): Promise<number> {
    const json = (await this.authed("/api/v3/account")) as { balances?: { asset: string; free: string }[] };
    const found = json.balances?.find((b) => b.asset === asset.toUpperCase());
    return found ? Number(found.free) : 0;
  }

  private async order(symbol: string, side: "BUY" | "SELL", quantity: number): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error("BinanceArbClient: API key/secret not configured");
    }
    const q = `symbol=${encodeURIComponent(symbol.toUpperCase())}&side=${side}&type=MARKET&quantity=${quantity}&${this.signedQuery()}`;
    const res = await fetch(`${this.baseUrl}/api/v3/order?${q}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": this.apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`Binance ${side} order failed with status ${res.status}`);
    }
  }

  async marketBuy(symbol: string, amount: number): Promise<void> {
    await this.order(symbol, "BUY", amount);
  }

  async marketSell(symbol: string, amount: number): Promise<void> {
    await this.order(symbol, "SELL", amount);
  }
}
