import { AuditDb } from "../db.js";
import { PortfolioManager } from "../portfolio/manager.js";
import { PriceFeed } from "../market/priceFeed.js";
import { SentimentEngine } from "../sentiment/engine.js";
import { TelegramNotifier } from "./telegram.js";
import { SymbolPair } from "../types.js";
import { computeMetrics } from "../report/metrics.js";
import { pino, type Logger } from "pino";

export class DailyReporter {
  private db: AuditDb;
  private portfolio: PortfolioManager;
  private priceFeed: PriceFeed;
  private sentiment: SentimentEngine;
  private notifier: TelegramNotifier;
  private symbols: SymbolPair[];
  private logger: Logger;

  constructor(
    db: AuditDb,
    portfolio: PortfolioManager,
    priceFeed: PriceFeed,
    sentiment: SentimentEngine,
    notifier: TelegramNotifier,
    symbols: SymbolPair[],
    logger: Logger
  ) {
    this.db = db;
    this.portfolio = portfolio;
    this.priceFeed = priceFeed;
    this.sentiment = sentiment;
    this.notifier = notifier;
    this.symbols = symbols;
    this.logger = logger;
  }

  private dayKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  async generateReport(): Promise<string> {
    const state = this.portfolio.state();
    const day = this.dayKey(new Date());
    const dayStart = `${day}T00:00:00.000Z`;
    const dayEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const todayTrades = this.db.tradesBetween(dayStart, `${dayEnd}T00:00:00.000Z`);

    const prevSnapshot = this.db.latestSnapshot();
    const prevEquity = prevSnapshot ? prevSnapshot.equity : state.equity;
    const dayChangePct = prevEquity > 0 ? ((state.equity - prevEquity) / prevEquity) * 100 : 0;

    const lines: string[] = [];
    lines.push("<b>Nobitex Sentiment Bot - Daily Report</b>");
    lines.push(`Date: ${day}`);
    lines.push("");
    lines.push(`<b>Portfolio</b>`);
    lines.push(`Equity: ${state.equity.toLocaleString()} ${this.quoteLabel()}`);
    lines.push(`Cash: ${state.cash.toLocaleString()} ${this.quoteLabel()}`);
    lines.push(`Positions value: ${state.positionsValue.toLocaleString()}`);
    lines.push(`Unrealized PnL: ${state.unrealizedPnl >= 0 ? "+" : ""}${state.unrealizedPnl.toLocaleString()}`);
    lines.push(`Realized today: ${state.realizedPnlToday >= 0 ? "+" : ""}${state.realizedPnlToday.toLocaleString()}`);
    lines.push(`Day change: ${dayChangePct >= 0 ? "+" : ""}${dayChangePct.toFixed(2)}%`);

    if (state.positions.length > 0) {
      lines.push("");
      lines.push("<b>Open positions</b>");
      for (const p of state.positions) {
        lines.push(
          `${p.symbol.toUpperCase()}: ${p.amount} @ ${p.entryPrice.toLocaleString()} -> ${(p.marketValue / p.amount).toLocaleString()} (${p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toLocaleString()})`
        );
      }
    }

    lines.push("");
    lines.push(`<b>Trades today</b>: ${todayTrades.length}`);
    if (todayTrades.length > 0) {
      for (const t of todayTrades.slice(-10)) {
        lines.push(`${t.symbol.toUpperCase()} ${t.side.toUpperCase()} ${t.amount} @ ${t.price.toLocaleString()}`);
      }
    }

    lines.push("");
    lines.push("<b>Performance (last 30d)</b>");
    const perf = computeMetrics(this.db);
    lines.push(`Return: ${perf.returnPct !== null ? (perf.returnPct >= 0 ? "+" : "") + perf.returnPct.toFixed(2) + "%" : "n/a"} (${perf.startEquity !== null ? perf.startEquity.toLocaleString() : "n/a"} -> ${perf.endEquity !== null ? perf.endEquity.toLocaleString() : "n/a"})`);
    lines.push(`Round trips: ${perf.roundTrips} (${perf.wins}W / ${perf.losses}L, win rate ${perf.winRatePct.toFixed(1)}%)`);
    lines.push(`Profit factor: ${perf.profitFactor === null ? "n/a" : perf.profitFactor === Infinity ? "inf" : perf.profitFactor.toFixed(2)}`);
    lines.push(`Net PnL: ${perf.netPnl >= 0 ? "+" : ""}${perf.netPnl.toLocaleString()}`);
    lines.push(`Max drawdown: ${perf.maxDrawdownPct !== null ? "-" + perf.maxDrawdownPct.toFixed(2) + "%" : "n/a"} | Sharpe: ${perf.sharpe !== null ? perf.sharpe.toFixed(2) : "n/a"}`);
    lines.push(`Fills (30d): ${perf.trades}`);

    lines.push("");
    lines.push("<b>Market snapshot</b>");
    for (const pair of this.symbols) {
      const price = this.priceFeed.getLatestPrice(pair.key);
      const sentiment = this.sentiment.snapshot(pair.src);
      lines.push(
        `${pair.key.toUpperCase()}: ${price !== null ? price.toLocaleString() : "n/a"} | sentiment ${sentiment.count > 0 ? sentiment.score.toFixed(2) + ` (${sentiment.count})` : "none"}`
      );
    }

    this.db.insertPortfolioSnapshot({
      ts: new Date().toISOString(),
      equity: state.equity,
      cash: state.cash,
      positionsValue: state.positionsValue,
      unrealizedPnl: state.unrealizedPnl,
      realizedPnlDay: state.realizedPnlToday,
      data: JSON.stringify({ positions: state.positions.map((p) => ({ symbol: p.symbol, amount: p.amount, entryPrice: p.entryPrice })) }),
    });
    this.db.setMeta("prev_day_equity", String(state.equity));
    this.db.setMeta(`day:${day}:snapshot`, JSON.stringify({ equity: state.equity, realized: state.realizedPnlToday }));

    return lines.join("\n");
  }

  private quoteLabel(): string {
    return this.symbols[0]?.dst.toUpperCase() ?? "QUOTE";
  }

  async sendDaily(): Promise<boolean> {
    const report = await this.generateReport();
    return this.notifier.send(report, "daily");
  }
}
