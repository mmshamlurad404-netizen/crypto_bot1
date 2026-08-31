import { MarketStat, WalletBalance } from "../types.js";

const USER_AGENT = "TraderBot/sentibot-1.0.0";
const PUBLIC_RATE_LIMIT_MS = 3000;

interface RequestOptions {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth?: boolean;
  publicRateLimit?: boolean;
}

export class NobitexError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

export class NobitexClient {
  private baseUrl: string;
  private apiKey: string;
  private lastPublicCall: Record<string, number> = {};
  private minPublicGapMs: number;

  constructor(baseUrl: string, apiKey: string, minPublicGapMs = PUBLIC_RATE_LIMIT_MS) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.minPublicGapMs = minPublicGapMs;
  }

  private async throttle(key: string): Promise<void> {
    const last = this.lastPublicCall[key] ?? 0;
    const wait = this.minPublicGapMs - (Date.now() - last);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this.lastPublicCall[key] = Date.now();
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    if (opts.publicRateLimit) {
      await this.throttle(opts.path);
    }
    const url = new URL(`${this.baseUrl}${opts.path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (opts.auth) {
      if (!this.apiKey) {
        throw new NobitexError("NOBITEX_API_KEY is not configured but an authenticated endpoint was called");
      }
      headers["Authorization"] = `Token ${this.apiKey}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(url.toString(), { method: opts.method ?? "GET", headers, body, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      throw new NobitexError(`Network error calling ${opts.path}: ${(err as Error).message}`);
    }
    if (res.status === 429) {
      throw new NobitexError(`Rate limited on ${opts.path}`, "TooManyRequests");
    }
    const text = await res.text();
    let json: T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      throw new NobitexError(`Invalid JSON from ${opts.path} (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return json;
  }

  async marketStats(srcCurrencies: string[], dstCurrencies: string[]): Promise<Record<string, MarketStat>> {
    const data = await this.request<{ status: string; stats: Record<string, MarketStat> }>({
      path: "/market/stats",
      query: {
        srcCurrency: srcCurrencies.join(","),
        dstCurrency: dstCurrencies.join(","),
      },
      publicRateLimit: true,
    });
    if (data.status !== "ok") {
      throw new NobitexError(`market/stats failed with status ${data.status}`);
    }
    return data.stats;
  }

  async recentTrades(symbol: string): Promise<{ time: number; price: string; volume: string; type: string }[]> {
    const data = await this.request<{ status: string; trades: { time: number; price: string; volume: string; type: string }[] }>({
      path: `/v2/trades/${symbol}`,
      publicRateLimit: true,
    });
    if (data.status !== "ok") {
      throw new NobitexError(`v2/trades failed with status ${data.status}`);
    }
    return data.trades;
  }

  async udfHistory(
    symbol: string,
    resolution: number,
    from: number,
    to: number
  ): Promise<{ s: string; t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }> {
    return this.request({
      path: "/market/udf/history",
      query: { symbol, resolution, from, to },
      publicRateLimit: true,
    });
  }

  async wallets(): Promise<WalletBalance[]> {
    const data = await this.request<{ status: string; wallets: WalletBalance[] }>({
      path: "/users/wallets/list",
      method: "POST",
      body: { type: "spot" },
      auth: true,
    });
    if (data.status !== "ok") {
      throw new NobitexError(`wallets/list failed with status ${data.status}`);
    }
    return data.wallets;
  }

  async addOrder(params: {
    type: "buy" | "sell";
    execution: "market" | "limit";
    srcCurrency: string;
    dstCurrency: string;
    amount: string;
    price?: string;
    clientOrderId: string;
  }): Promise<{ status: string; order?: Record<string, unknown>; code?: string; message?: string }> {
    const body: Record<string, string> = {
      type: params.type,
      execution: params.execution,
      srcCurrency: params.srcCurrency,
      dstCurrency: params.dstCurrency,
      amount: params.amount,
      clientOrderId: params.clientOrderId,
    };
    if (params.price) body.price = params.price;
    return this.request<{ status: string; order?: Record<string, unknown>; code?: string; message?: string }>({
      path: "/market/orders/add",
      method: "POST",
      body,
      auth: true,
    });
  }

  async orderStatus(input: { id?: number; clientOrderId?: string }): Promise<{ status: string; order?: Record<string, unknown>; code?: string; message?: string }> {
    return this.request({
      path: "/market/orders/status",
      method: "POST",
      body: input,
      auth: true,
    });
  }

  async cancelOrder(orderId: number): Promise<{ status: string; code?: string; message?: string }> {
    return this.request({
      path: "/market/orders/update-status",
      method: "POST",
      body: { order: orderId, status: "canceled" },
      auth: true,
    });
  }

  async marginBalance(currency: string): Promise<{ status: string; marginTradesBalance: Record<string, unknown>[] }> {
    return this.request({
      path: "/v2/margin",
      method: "POST",
      body: { currency },
      auth: true,
    });
  }

  async marginAddOrder(params: {
    type: "buy" | "sell";
    execution: "market" | "limit";
    srcCurrency: string;
    dstCurrency: string;
    amount: string;
    price?: string;
    leverage: number;
    clientOrderId?: string;
  }): Promise<{ status: string; order?: Record<string, unknown>; code?: string; message?: string }> {
    const body: Record<string, string | number> = {
      type: params.type,
      execution: params.execution,
      srcCurrency: params.srcCurrency,
      dstCurrency: params.dstCurrency,
      amount: params.amount,
      leverage: params.leverage,
    };
    if (params.price) body.price = params.price;
    if (params.clientOrderId) body.clientOrderId = params.clientOrderId;
    return this.request<{ status: string; order?: Record<string, unknown>; code?: string; message?: string }>({
      path: "/v2/margin/orders/add",
      method: "POST",
      body,
      auth: true,
    });
  }

  async marginOrderStatus(input: { id?: number; srcCurrency: string; dstCurrency: string }): Promise<{ status: string; order?: Record<string, unknown>; code?: string; message?: string }> {
    return this.request({
      path: "/v2/margin/orders/status",
      method: "POST",
      body: input,
      auth: true,
    });
  }

  async marginCloseOrder(params: { srcCurrency: string; dstCurrency: string; amount: string }): Promise<{ status: string; closeOrder?: Record<string, unknown>; code?: string; message?: string }> {
    return this.request({
      path: "/v2/margin/orders/close",
      method: "POST",
      body: params,
      auth: true,
    });
  }
}
