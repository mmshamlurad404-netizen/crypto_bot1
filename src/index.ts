import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AuditDb } from "./db.js";
import { NobitexClient } from "./exchange/nobitex.js";
import { PriceFeed } from "./market/priceFeed.js";
import { SentimentEngine } from "./sentiment/engine.js";
import { SentimentWebhook } from "./sentiment/server.js";
import { PortfolioManager } from "./portfolio/manager.js";
import { RiskManager } from "./risk/manager.js";
import { Executor } from "./execution/executor.js";
import { HybridStrategy } from "./strategy/hybrid.js";
import { DcaLadder } from "./strategy/dca.js";
import { TelegramNotifier } from "./alerts/telegram.js";
import { DailyReporter } from "./alerts/report.js";
import { SignalDecision } from "./types.js";

async function scheduleDaily(reporter: DailyReporter, time: string): Promise<NodeJS.Timeout> {
  const [h, m] = time.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h!, m!, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const delay = next.getTime() - now.getTime();
  const timer = setTimeout(async () => {
    await reporter.sendDaily();
    setInterval(() => {
      void reporter.sendDaily();
    }, 24 * 60 * 60 * 1000).unref();
  }, delay);
  timer.unref();
  return timer;
}

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const db = new AuditDb(config.dbPath);
  const client = new NobitexClient(config.nobitexBaseUrl, config.nobitexApiKey);
  const priceFeed = new PriceFeed(client, config.symbols, config.seriesMaxPoints, config.seedSeriesFromTrades);
  const sentimentEngine = new SentimentEngine(db, config.sentimentWindowMs, config.sentimentHalfLifeMs, config.sentimentMinConfidence);
  const webhook = new SentimentWebhook(sentimentEngine, config.sentimentWebhookToken, config.sentimentWebhookPort, logger, config.sentimentJsonFeed);
  const portfolio = new PortfolioManager(db, client, priceFeed, config.symbols, config.quoteCurrency, config.dryRun, config.virtualStartEquity);
  const risk = new RiskManager(db, priceFeed, portfolio, {
    maxPositionSizePct: config.maxPositionSizePct,
    maxTotalExposurePct: config.maxTotalExposurePct,
    maxDailyLossPct: config.maxDailyLossPct,
    maxTradesPerDay: config.maxTradesPerDay,
    minOrderValue: config.minOrderValue,
    volatilityMax: config.volatilityMax,
    volatilityBenchmark: config.volatilityBenchmark,
    volatilitySizeCap: config.volatilitySizeCap,
    cooldownMinutes: config.cooldownMinutes,
    rsiPeriod: config.rsiPeriod,
    rsiEntryUpper: config.rsiEntryUpper,
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    trailingStopPct: config.trailingStopPct,
    trailingStopActivatePct: config.trailingStopActivatePct,
    trailingTpPct: config.trailingTpPct,
    trailingTpActivatePct: config.trailingTpActivatePct,
  });
  const executor = new Executor(db, client, priceFeed, portfolio, risk, config.dryRun, config.feePct, logger);
  const dcaLadder = new DcaLadder({
    enabled: config.dcaEnabled,
    levels: config.dcaLevels,
    maxOrders: config.dcaMaxOrdersPerPosition,
  });
  const strategy = new HybridStrategy(db, priceFeed, sentimentEngine, portfolio, risk, {
    rsiPeriod: config.rsiPeriod,
    rsiOverbought: config.rsiOverbought,
    rsiEntryUpper: config.rsiEntryUpper,
    sentimentEntryThreshold: config.sentimentEntryThreshold,
    sentimentExitThreshold: config.sentimentExitThreshold,
  }, dcaLadder);
  const notifier = new TelegramNotifier(db, config.telegramBotToken, config.telegramChatId, logger);
  const reporter = new DailyReporter(db, portfolio, priceFeed, sentimentEngine, notifier, config.symbols, logger);

  webhook.start();

  logger.info(
    {
      mode: config.dryRun ? "DRY-RUN (simulated fills)" : "LIVE",
      trading: config.tradingEnabled ? "ENABLED" : "DISABLED (monitor-only)",
      symbols: config.symbols.map((s) => s.key),
      quote: config.quoteCurrency,
      risk: {
        maxPositionPct: config.maxPositionSizePct,
        maxExposurePct: config.maxTotalExposurePct,
        maxDailyLossPct: config.maxDailyLossPct,
        maxTradesPerDay: config.maxTradesPerDay,
        volatilityMax: config.volatilityMax,
      },
      dca: {
        enabled: config.dcaEnabled,
        levels: config.dcaLevels.map((l) => `${l.belowPct}%/-${l.buyPct}%`),
        maxOrdersPerPosition: config.dcaMaxOrdersPerPosition,
      },
    },
    "bot started"
  );

  let running = true;

  async function executeDecision(decision: SignalDecision): Promise<void> {
    const pair = config.symbols.find((s) => s.key === decision.symbol);
    if (!pair) return;

    if (decision.action === "BUY") {
      const price = decision.price ?? priceFeed.getLatestPrice(pair.key);
      if (!price) return;
      const equity = portfolio.equity();
      const sizePct = decision.sizePct ?? config.maxPositionSizePct;
      const budget = equity * (sizePct / 100);
      const amount = budget / price;
      if (!config.tradingEnabled && !config.dryRun) {
        logger.info({ symbol: pair.key, action: "BUY", amount, price, reason: decision.reason }, "signal generated (trading disabled)");
        db.insertSignal({
          ts: new Date().toISOString(),
          symbol: pair.key,
          action: "BUY",
          rsi: decision.rsi,
          sentiment: decision.sentiment,
          price,
          seriesLen: priceFeed.getSeries(pair.key).length,
          reason: decision.reason,
          details: "trading disabled, signal recorded only",
        });
        return;
      }
      const fill = await executor.buy(pair, amount, decision.dca ? "dca" : "entry");
      if (fill) {
        await notifier.sendTradeAlert(pair.key, "buy", fill.amount, fill.price, fill.total, fill.simulated, decision.reason);
      }
    } else if (decision.action === "SELL") {
      const pos = db.getOpenPosition(pair.key);
      if (!pos) return;
      if (!config.tradingEnabled && !config.dryRun) {
        logger.info({ symbol: pair.key, action: "SELL", amount: pos.amount, reason: decision.reason }, "sell signal generated (trading disabled)");
        return;
      }
      const fill = await executor.sell(pair, pos.amount);
      if (fill) {
        await notifier.sendTradeAlert(pair.key, "sell", fill.amount, fill.price, fill.total, fill.simulated, decision.reason);
      }
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await priceFeed.poll();
      await portfolio.refresh();
      const state = portfolio.state();
      for (const pair of config.symbols) {
        const decision = strategy.evaluate(pair);
        if (decision.action === "BUY" || decision.action === "SELL") {
          db.insertSignal({
            ts: new Date().toISOString(),
            symbol: decision.symbol,
            action: decision.action,
            rsi: decision.rsi,
            sentiment: decision.sentiment,
            price: decision.price,
            seriesLen: priceFeed.getSeries(pair.key).length,
            reason: decision.reason,
            details: null,
          });
          await executeDecision(decision);
        } else {
          logger.debug({ symbol: decision.symbol, reason: decision.reason }, "HOLD");
        }
      }
      logger.debug(
        {
          equity: Math.round(state.equity),
          cash: Math.round(state.cash),
          positionsValue: Math.round(state.positionsValue),
          unrealized: Math.round(state.unrealizedPnl),
        },
        "portfolio tick"
      );
    } catch (err) {
      logger.error({ error: (err as Error).message }, "tick failed");
      db.insertRiskEvent({
        ts: new Date().toISOString(),
        symbol: null,
        kind: "error",
        message: (err as Error).message,
        data: null,
      });
    }
  }

  const pollTimer = setInterval(() => void tick(), config.pricePollMs);
  void tick();
  void scheduleDaily(reporter, config.dailyReportTime);

  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    logger.info({ signal }, "shutting down");
    clearInterval(pollTimer);
    await webhook.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
