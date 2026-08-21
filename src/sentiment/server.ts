import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { SentimentEngine } from "./engine.js";
import { SentimentInput } from "../types.js";
import { pino, type Logger } from "pino";

const MAX_BODY_BYTES = 64 * 1024;

export class SentimentWebhook {
  private engine: SentimentEngine;
  private token: string;
  private port: number;
  private server: ReturnType<typeof createServer> | null = null;
  private logger: Logger;
  private feedPath: string;
  private feedMtime = 0;
  private feedOffset = 0;

  constructor(engine: SentimentEngine, token: string, port: number, logger: Logger, feedPath: string) {
    this.engine = engine;
    this.token = token;
    this.port = port;
    this.logger = logger;
    this.feedPath = feedPath;
  }

  start(): void {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.listen(this.port, "0.0.0.0", () => {
      this.logger.info(`sentiment webhook listening on :${this.port}`);
    });
    if (this.feedPath) {
      this.pollFeed();
      setInterval(() => this.pollFeed(), 5000);
    }
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
    const snapshots = [];
    let errors = 0;
    for (const input of inputs) {
      if (!input || typeof input.account !== "string" || !input.account || typeof input.symbol !== "string" || !input.symbol || typeof input.sentiment !== "number") {
        errors++;
        continue;
      }
      const snap = this.engine.ingest(input);
      snapshots.push(snap);
    }
    this.logger.debug({ count: inputs.length, errors }, "sentiment ingested via webhook");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", accepted: snapshots.length, errors, snapshots }));
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
          this.engine.ingest(input);
          accepted++;
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
