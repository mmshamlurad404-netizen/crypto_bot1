import { AuditDb } from "../db.js";
import { pino, type Logger } from "pino";

export class TelegramNotifier {
  private db: AuditDb;
  private botToken: string;
  private chatId: string;
  private logger: Logger;
  private baseUrl: string;

  constructor(db: AuditDb, botToken: string, chatId: string, logger: Logger, baseUrl = "https://api.telegram.org") {
    this.db = db;
    this.botToken = botToken;
    this.chatId = chatId;
    this.logger = logger;
    this.baseUrl = baseUrl;
  }

  get enabled(): boolean {
    return this.botToken !== "" && this.chatId !== "";
  }

  async send(message: string, type = "info"): Promise<boolean> {
    this.db.insertAlert({ ts: new Date().toISOString(), type, channel: "telegram", message });
    if (!this.enabled) {
      this.logger.info({ type }, "telegram not configured, alert logged only");
      return false;
    }
    try {
      const res = await fetch(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!res.ok || !data.ok) {
        this.logger.error({ description: data.description }, "telegram send failed");
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, "telegram send error");
      return false;
    }
  }

  async sendTradeAlert(symbol: string, side: "buy" | "sell", amount: number, price: number, total: number, simulated: boolean, reason?: string): Promise<boolean> {
    const emoji = side === "buy" ? "BUY" : "SELL";
    const mode = simulated ? " [SIMULATED]" : "";
    const lines = [
      `<b>${emoji} ${symbol.toUpperCase()}${mode}</b>`,
      `Amount: ${amount} @ ${price.toLocaleString()}`,
      `Total: ${total.toLocaleString()}`,
    ];
    if (reason) lines.push(`Reason: ${reason}`);
    return this.send(lines.join("\n"), "trade");
  }
}
