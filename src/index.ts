import { loadConfig, loadConfigs, BotConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AuditDb } from "./db.js";
import { NobitexClient } from "./exchange/nobitex.js";
import { PriceFeed } from "./market/priceFeed.js";
import { SentimentEngine } from "./sentiment/engine.js";
import { SentimentWebhook } from "./sentiment/server.js";
import { SignalBroker, TradeIntent } from "./signals/broker.js";
import { PortfolioManager } from "./portfolio/manager.js";
import { RiskManager } from "./risk/manager.js";
import { Executor } from "./execution/executor.js";
import { DcaLadder } from "./strategy/dca.js";
import { TriggerEngine } from "./triggers/engine.js";
import { computeIndicators } from "./indicators.js";
import { buildStrategyPool } from "./config/pools.js";
import { TelegramNotifier } from "./alerts/telegram.js";
import { DailyReporter } from "./alerts/report.js";
import { SignalDecision, SymbolPair } from "./types.js";
import { pino, type Logger } from "pino";

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

export interface BotRuntime {
  name: string;
  stop: () => Promise<void>;
}

export function startBot(config: BotConfig, baseLogger: Logger): BotRuntime {
  const logger = baseLogger.child({ bot: config.botName });
  const db = new AuditDb(config.dbPath);
  const client = new NobitexClient(config.nobitexBaseUrl, config.nobitexApiKey);
  const priceFeed = new PriceFeed(client, config.symbols, config.seriesMaxPoints, config.seedSeriesFromTrades);
  const sentimentEngine = new SentimentEngine(db, config.sentimentWindowMs, config.sentimentHalfLifeMs, config.sentimentMinConfidence);
  const signals = new SignalBroker();
  signals.onSentiment((intent) =>
    sentimentEngine.ingest({
      account: intent.account ?? "sentiment-webhook",
      symbol: intent.symbol,
      sentiment: intent.sentiment!,
      confidence: intent.confidence,
    })
  );
  const webhook =
    config.sentimentWebhookPort > 0
      ? new SentimentWebhook(signals, config.sentimentWebhookToken, config.sentimentWebhookPort, logger, config.sentimentJsonFeed, {
          tradingViewEnabled: config.tradingViewEnabled,
          db,
          symbols: config.symbols,
        })
      : null;
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
  const triggers = new TriggerEngine(config.triggers);
  const strategyPool = buildStrategyPool({
    pool: config.strategyPools,
    symbols: config.symbols,
    db,
    priceFeed,
    sentiment: sentimentEngine,
    portfolio,
    risk,
    strategyConfig: {
      rsiPeriod: config.rsiPeriod,
      rsiOverbought: config.rsiOverbought,
      rsiEntryUpper: config.rsiEntryUpper,
      sentimentEntryThreshold: config.sentimentEntryThreshold,
      sentimentExitThreshold: config.sentimentExitThreshold,
    },
    dca: dcaLadder,
    ai: config.aiAdvisor,
  });
  const notifier = new TelegramNotifier(db, config.telegramBotToken, config.telegramChatId, logger);
  const reporter = new DailyReporter(db, portfolio, priceFeed, sentimentEngine, notifier, config.symbols, logger);

  webhook?.start();

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
      triggers: triggers.count,
      strategies: config.symbols.map((s) => `${s.key}:${config.strategyPools[s.key] ? config.strategyPools[s.key]!.kind : "hybrid"}`),
      tradingview: config.tradingViewEnabled ? "ENABLED" : "DISABLED",
      webhook: webhook ? `:${config.sentimentWebhookPort}` : "disabled",
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

  async function processTradingViewIntent(tv: TradeIntent, pair: SymbolPair): Promise<void> {
    const ts = new Date().toISOString();
    if (tv.action === "BUY") {
      const price = tv.price ?? priceFeed.getLatestPrice(pair.key);
      if (!price) {
        logger.warn({ symbol: pair.key }, "tradingview buy skipped: no market price");
        return;
      }
      const closes = priceFeed.getCloses(pair.key);
      const { rsi, volatility } = computeIndicators(closes, config.rsiPeriod);
      const sentiment = sentimentEngine.snapshot(pair.src).score;
      const sizePct = risk.sizeByVolatility(volatility);
      const orderValue = portfolio.equity() * (sizePct / 100);
      const verdict = risk.evaluateBuy(pair, orderValue, volatility, rsi, { skipRsiGate: true });
      if (!verdict.allowed) {
        db.insertSignal({
          ts,
          symbol: pair.key,
          action: "HOLD",
          rsi,
          sentiment,
          price,
          seriesLen: closes.length,
          reason: `tradingview blocked: ${verdict.reason}`,
          details: null,
        });
        logger.info({ symbol: pair.key, reason: verdict.reason }, "tradingview buy blocked by risk");
        return;
      }
      const decision: SignalDecision = {
        symbol: pair.key,
        action: "BUY",
        rsi,
        sentiment,
        price,
        reason: `tradingview signal (${verdict.reason ?? "risk approved"})`,
        sizePct: verdict.sizePct || sizePct,
      };
      db.insertSignal({
        ts,
        symbol: pair.key,
        action: decision.action,
        rsi: decision.rsi,
        sentiment: decision.sentiment,
        price: decision.price,
        seriesLen: priceFeed.getSeries(pair.key).length,
        reason: decision.reason,
        details: `source: ${tv.source}`,
      });
      await executeDecision(decision);
    } else {
      const pos = db.getOpenPosition(pair.key);
      if (!pos) {
        db.insertSignal({
          ts,
          symbol: pair.key,
          action: "HOLD",
          rsi: null,
          sentiment: null,
          price: tv.price ?? priceFeed.getLatestPrice(pair.key),
          seriesLen: priceFeed.getSeries(pair.key).length,
          reason: "tradingview sell ignored: no open position",
          details: `source: ${tv.source}`,
        });
        logger.info({ symbol: pair.key }, "tradingview sell ignored: no open position");
        return;
      }
      const decision: SignalDecision = {
        symbol: pair.key,
        action: "SELL",
        rsi: null,
        sentiment: null,
        price: tv.price ?? priceFeed.getLatestPrice(pair.key),
        reason: "tradingview signal",
      };
      db.insertSignal({
        ts,
        symbol: pair.key,
        action: decision.action,
        rsi: null,
        sentiment: null,
        price: decision.price,
        seriesLen: priceFeed.getSeries(pair.key).length,
        reason: decision.reason,
        details: `source: ${tv.source}`,
      });
      await executeDecision(decision);
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await priceFeed.poll();
      await portfolio.refresh();
      const state = portfolio.state();
      for (const pair of config.symbols) {
        const closes = priceFeed.getCloses(pair.key);
        const { rsi } = computeIndicators(closes, config.rsiPeriod);
        const sentiment = sentimentEngine.snapshot(pair.src).score;
        const price = priceFeed.getLatestPrice(pair.key);
        for (const ev of triggers.evaluate({ symbol: pair.key, price, rsi, sentiment })) {
          logger.warn({ trigger: ev.ruleId, symbol: ev.symbol, action: ev.actionType }, "trigger fired");
          db.insertRiskEvent({
            ts: new Date().toISOString(),
            symbol: ev.symbol,
            kind: "trigger",
            message: ev.message,
            data: JSON.stringify({ ruleId: ev.ruleId, action: ev.actionType }),
          });
          if (ev.actionType === "notify") {
            await notifier.send(ev.message, "trigger");
          } else if (ev.actionType === "halt") {
            risk.haltTrading(ev.message);
          }
        }
        const decision = await strategyPool.get(pair.key)!.evaluate(pair);
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
        const tvIntent = signals.shiftTrade(pair.key);
        if (tvIntent) {
          await processTradingViewIntent(tvIntent, pair);
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

  return {
    name: config.botName,
    stop: async () => {
      if (!running) return;
      running = false;
      logger.info("bot stopping");
      clearInterval(pollTimer);
      await webhook?.stop();
      db.close();
    },
  };
}

function main(): void {
  const configs = loadConfigs();
  const logger = createLogger(configs[0]!.logLevel);
  const bots = configs.map((config) => startBot(config, logger));
  logger.info({ count: bots.length }, "all bots started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await Promise.all(bots.map((b) => b.stop()));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
