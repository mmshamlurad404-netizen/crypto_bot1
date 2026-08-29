import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { SentimentInput, SymbolPair } from "../types.js";
import { AuditDb } from "../db.js";
import { SignalBroker, TradeIntent } from "../signals/broker.js";
import { pino, type Logger } from "pino";

const MAX_BODY_BYTES = 64 * 1024;

interface TradingViewAlert {
  symbol?: string;
  ticker?: string;
  action?: string;
  close?: number;
  strategy?: { order?: { action?: string } };
}

function resolveTradingViewAction(payload: TradingViewAlert): string | null {
  const raw = (payload.strategy?.order?.action ?? payload.action ?? "").toString().toLowerCase().trim();
  if (!raw) return null;
  if (["buy", "long", "entry"].includes(raw)) return "BUY";
  if (["sell", "short", "exit", "close"].includes(raw)) return "SELL";
  if (["hold", "none", "flat"].includes(raw)) return "SKIP";
  return "UNKNOWN";
}

function resolveTradingViewSymbol(payload: TradingViewAlert, symbols: SymbolPair[]): SymbolPair | null {
  if (payload.symbol) {
    const key = payload.symbol.trim().toLowerCase();
    return symbols.find((s) => s.key === key) ?? null;
  }
  if (payload.ticker) {
    const raw = payload.ticker
      .trim()
      .split(":")
      .pop()!
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return symbols.find((s) => `${s.src}${s.dst}`.toUpperCase() === raw) ?? null;
  }
  return null;
}

export function parseTradingViewAlert(body: string, symbols: SymbolPair[], nowIso: string): { intent: TradeIntent | null; error: string | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { intent: null, error: "invalid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { intent: null, error: "payload must be a JSON object" };
  }
  const alert = payload as TradingViewAlert;
  const pair = resolveTradingViewSymbol(alert, symbols);
  if (!pair) {
    return { intent: null, error: `no symbol match for symbol="${alert.symbol ?? ""}" ticker="${alert.ticker ?? ""}"` };
  }
  const action = resolveTradingViewAction(alert);
  if (action === null || action === "UNKNOWN") {
    return { intent: null, error: `unsupported action "${alert.strategy?.order?.action ?? alert.action}"` };
  }
  if (action === "SKIP") return { intent: null, error: null };
  const price = typeof alert.close === "number" && Number.isFinite(alert.close) && alert.close > 0 ? alert.close : null;
  return { intent: { source: "tradingview", symbol: pair.key, action: action as "BUY" | "SELL", price, receivedAt: nowIso, raw: body }, error: null };
}

export class SentimentWebhook {
  private broker: SignalBroker;
  private token: string;
  private port: number;
  private server: ReturnType<typeof createServer> | null = null;
  private logger: Logger;
  private feedPath: string;
  private feedMtime = 0;
  private feedOffset = 0;
  private tradingViewEnabled: boolean;
  private db: AuditDb;
  private symbols: SymbolPair[];

  constructor(
    broker: SignalBroker,
    token: string,
    port: number,
    logger: Logger,
    feedPath: string,
    options: { tradingViewEnabled: boolean; db: AuditDb; symbols: SymbolPair[] }
  ) {
    this.broker = broker;
    this.token = token;
    this.port = port;
    this.logger = logger;
    this.feedPath = feedPath;
    this.tradingViewEnabled = options.tradingViewEnabled;
    this.db = options.db;
    this.symbols = options.symbols;
  }

  start(): void {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.listen(this.port, "0.0.0.0", () => {
      this.logger.info(`sentiment webhook listening on :${this.boundPort() ?? this.port}`);
    });
    if (this.feedPath) {
      this.pollFeed();
      setInterval(() => this.pollFeed(), 5000);
    }
  }

  boundPort(): number | null {
    const addr = this.server?.address();
    return typeof addr === "object" && addr !== null ? addr.port : null;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error("body too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/tradingview") {
      await this.handleTradingView(req, res);
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/api/v1/sentiment") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "NotFound" }));
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${this.token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "Unauthorized" }));
      return;
    }
    let payload: SentimentInput | SentimentInput[];
    try {
      const text = await this.readBody(req);
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        payload = parsed as SentimentInput[];
      } else {
        payload = parsed as SentimentInput;
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "BadRequest", message: "invalid JSON" }));
      return;
    }
    const inputs = Array.isArray(payload) ? payload : [payload];
    const snapshots: unknown[] = [];
    let errors = 0;
    for (const input of inputs) {
      if (!input || typeof input.account !== "string" || !input.account || typeof input.symbol !== "string" || !input.symbol || typeof input.sentiment !== "number") {
        errors++;
        continue;
      }
      const result = this.broker.submit({
        source: "sentiment-webhook",
        kind: "sentiment",
        account: input.account,
        symbol: input.symbol,
        sentiment: input.sentiment,
        confidence: input.confidence,
        receivedAt: new Date().toISOString(),
      });
      if (!result.accepted) {
        errors++;
        continue;
      }
      snapshots.push(result.result);
    }
    this.logger.debug({ count: inputs.length, errors }, "sentiment ingested via webhook");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", accepted: snapshots.length, errors, snapshots }));
  }

  private async handleTradingView(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.tradingViewEnabled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "NotFound" }));
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${this.token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "Unauthorized" }));
      return;
    }
    let text: string;
    try {
      text = await this.readBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "BadRequest", message: "body too large" }));
      return;
    }
    const { intent, error } = parseTradingViewAlert(text, this.symbols, new Date().toISOString());
    if (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", code: "BadRequest", message: error }));
      return;
    }
    let accepted = 0;
    if (intent) {
      const result = this.broker.submit({ ...intent, kind: "trade" });
      accepted = result.accepted ? 1 : 0;
      if (result.accepted) {
        this.db.insertTradingViewSignal({
          ts: intent.receivedAt,
          symbol: intent.symbol,
          action: intent.action,
          price: intent.price,
          ticker: null,
          raw: intent.raw ?? null,
        });
      }
    }
    this.logger.debug({ symbol: intent?.symbol ?? null, action: intent?.action ?? null }, "tradingview alert ingested via webhook");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", accepted }));
  }

  private pollFeed(): void {
    try {
      const st = statSync(this.feedPath);
      if (!st.isFile()) return;
      if (st.mtimeMs === this.feedMtime) return;
      const content = readFileSync(this.feedPath, "utf8");
      this.feedMtime = st.mtimeMs;
      this.feedOffset = 0;
      let accepted = 0;
      let errors = 0;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const input = JSON.parse(trimmed) as SentimentInput;
          if (!input.account || !input.symbol || typeof input.sentiment !== "number") {
            errors++;
            continue;
          }
          const result = this.broker.submit({
            source: "sentiment-feed",
            kind: "sentiment",
            account: input.account,
            symbol: input.symbol,
            sentiment: input.sentiment,
            confidence: input.confidence,
            receivedAt: new Date().toISOString(),
          });
          if (result.accepted) accepted++;
          else errors++;
        } catch {
          errors++;
        }
      }
      this.logger.debug({ accepted, errors, path: this.feedPath }, "sentiment feed file parsed");
    } catch {
      this.feedMtime = 0;
    }
  }
}
