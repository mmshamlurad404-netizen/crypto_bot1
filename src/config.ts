import "dotenv/config";
import { z } from "zod";
import { SymbolPair, QuoteCurrency } from "./types.js";
import { TriggerRule } from "./triggers/engine.js";
import { parseStrategyPools, StrategySpec } from "./config/pools.js";

function boolEnv(dflt: boolean) {
  return z.preprocess((val) => {
    if (typeof val === "boolean") return val;
    if (val === undefined || val === null) return dflt;
    if (typeof val === "number") return val !== 0;
    const s = String(val).trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    return dflt;
  }, z.boolean());
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  BOT_NAME: z.string().default("default"),

  NOBITEX_API_KEY: z.string().default(""),
  NOBITEX_BASE_URL: z.string().url().default("https://apiv2.nobitex.ir"),
  DRY_RUN: boolEnv(true),
  TRADING_ENABLED: boolEnv(false),

  QUOTE_CURRENCY: z.enum(["rls", "usdt"]).default("rls"),
  SYMBOLS: z.string().min(1),

  RSI_PERIOD: z.coerce.number().int().min(2).default(14),
  RSI_OVERBOUGHT: z.coerce.number().min(0).max(100).default(70),
  RSI_ENTRY_UPPER: z.coerce.number().min(0).max(100).default(35),

  SENTIMENT_ENTRY_THRESHOLD: z.coerce.number().min(-1).max(1).default(0.3),
  SENTIMENT_EXIT_THRESHOLD: z.coerce.number().min(-1).max(1).default(-0.2),
  SENTIMENT_WINDOW_HOURS: z.coerce.number().positive().default(24),
  SENTIMENT_HALF_LIFE_HOURS: z.coerce.number().positive().default(12),
  SENTIMENT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.1),
  SENTIMENT_WEBHOOK_PORT: z.coerce.number().int().min(0).default(3001),
  SENTIMENT_WEBHOOK_TOKEN: z.string().default("changeme"),
  SENTIMENT_JSON_FEED: z.string().default(""),
  TRADINGVIEW_ENABLED: boolEnv(false),

  PRICE_POLL_SECONDS: z.coerce.number().int().min(5).default(60),
  SERIES_MAX_POINTS: z.coerce.number().int().positive().default(500),
  SEED_SERIES_FROM_TRADES: boolEnv(true),
  VIRTUAL_START_EQUITY: z.coerce.number().positive().default(100000000),

  MAX_POSITION_SIZE_PCT: z.coerce.number().min(0).max(100).default(10),
  MAX_TOTAL_EXPOSURE_PCT: z.coerce.number().min(0).max(100).default(40),
  MAX_DAILY_LOSS_PCT: z.coerce.number().min(0).max(100).default(3),
  MAX_TRADES_PER_DAY: z.coerce.number().int().min(0).default(6),
  MIN_ORDER_VALUE: z.coerce.number().min(0).default(5000000),
  VOLATILITY_MAX: z.coerce.number().min(0).default(0.05),
  VOLATILITY_BENCHMARK: z.coerce.number().min(0.0001).default(0.02),
  VOLATILITY_SIZE_CAP: z.coerce.number().min(1).default(2),
  STOP_LOSS_PCT: z.coerce.number().min(0).default(3),
  TAKE_PROFIT_PCT: z.coerce.number().min(0).default(6),
  TRAILING_STOP_PCT: z.coerce.number().min(0).max(50).default(0),
  TRAILING_STOP_ACTIVATE_PCT: z.coerce.number().min(0).max(100).default(1.5),
  TRAILING_TP_PCT: z.coerce.number().min(0).max(50).default(0),
  TRAILING_TP_ACTIVATE_PCT: z.coerce.number().min(0).max(100).default(2),
  COOLDOWN_MINUTES: z.coerce.number().int().min(0).default(30),
  FEE_PCT: z.coerce.number().min(0).max(10).default(0.25),

  DCA_ENABLED: boolEnv(false),
  DCA_MAX_ORDERS_PER_POSITION: z.coerce.number().int().min(0).default(4),
  DCA_LEVELS: z.string().default("[]"),

  MARGIN_ENABLED: boolEnv(false),
  MARGIN_LEVERAGE: z.coerce.number().min(1).max(10).default(2),
  MARGIN_MAX_SHORT_PCT: z.coerce.number().min(0).max(100).default(10),
  MARGIN_SYMBOLS: z.string().default(""),
  MARGIN_STOP_LOSS_PCT: z.coerce.number().min(0).default(3),
  MARGIN_TAKE_PROFIT_PCT: z.coerce.number().min(0).default(6),
  RSI_SHORT_ENTRY_FLOOR: z.coerce.number().min(0).max(100).default(65),

  MM_ENABLED: boolEnv(false),
  MM_SYMBOLS: z.string().default(""),
  MM_SPREAD_PCT: z.coerce.number().min(0.01).default(0.5),
  MM_ORDER_VALUE: z.coerce.number().positive().default(10000000),
  MM_MAX_INVENTORY_VALUE: z.coerce.number().positive().default(20000000),
  MM_STOP_LOSS_PCT: z.coerce.number().min(0).default(3),
  MM_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  MM_MAX_QUOTE_AGE_SECONDS: z.coerce.number().int().min(1).default(300),
  MM_MIN_ORDER_VALUE: z.coerce.number().min(0).default(5000000),

  ARB_ENABLED: boolEnv(false),
  ARB_EXCHANGE: z.string().default("binance"),
  ARB_SYMBOLS: z.string().default("{}"),
  ARB_FX_RATE: z.coerce.number().min(0).default(0),
  ARB_MIN_PROFIT_PCT: z.coerce.number().min(0).default(0.5),
  ARB_MAX_NOTIONAL_PCT: z.coerce.number().min(0).max(100).default(5),
  ARB_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(300),
  USER_ARB_API_KEY: z.string().default(""),
  USER_ARB_API_SECRET: z.string().default(""),

  TRIGGERS: z.string().default("[]"),

  STRATEGY_POOLS: z.string().default("{}"),

  USER_LLM_API_KEY: z.string().default(""),
  USER_LLM_BASE_URL: z.string().url().default("https://api.deepseek.com/v1"),
  USER_LLM_MODEL: z.string().default("deepseek-chat"),
  AI_ADVISOR_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(300),
  AI_ADVISOR_CONTEXT_BARS: z.coerce.number().int().min(5).default(40),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  DAILY_REPORT_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("08:00"),

  DB_PATH: z.string().default("./data/audit.db"),
});

export interface DcaLevel {
  belowPct: number;
  buyPct: number;
}

export interface MarginConfig {
  enabled: boolean;
  leverage: number;
  maxShortPct: number;
  symbols: string[];
  stopLossPct: number;
  takeProfitPct: number;
}

export interface MmConfig {
  enabled: boolean;
  symbols: string[];
  spreadPct: number;
  orderValue: number;
  maxInventoryValue: number;
  stopLossPct: number;
  cooldownMs: number;
  maxQuoteAgeMs: number;
  minOrderValue: number;
}

export interface ArbConfig {
  enabled: boolean;
  exchange: string;
  symbols: Record<string, string>;
  fxRate: number;
  minProfitPct: number;
  maxNotionalPct: number;
  cooldownMs: number;
  apiKey: string;
  apiSecret: string;
}

export interface BotConfig {
  botName: string;
  nodeEnv: string;
  logLevel: string;
  nobitexApiKey: string;
  nobitexBaseUrl: string;
  dryRun: boolean;
  tradingEnabled: boolean;
  quoteCurrency: QuoteCurrency;
  symbols: SymbolPair[];
  rsiPeriod: number;
  rsiOverbought: number;
  rsiEntryUpper: number;
  sentimentEntryThreshold: number;
  sentimentExitThreshold: number;
  sentimentWindowMs: number;
  sentimentHalfLifeMs: number;
  sentimentMinConfidence: number;
  sentimentWebhookPort: number;
  sentimentWebhookToken: string;
  sentimentJsonFeed: string;
  tradingViewEnabled: boolean;
  pricePollMs: number;
  seriesMaxPoints: number;
  seedSeriesFromTrades: boolean;
  virtualStartEquity: number;
  maxPositionSizePct: number;
  maxTotalExposurePct: number;
  maxDailyLossPct: number;
  maxTradesPerDay: number;
  minOrderValue: number;
  volatilityMax: number;
  volatilityBenchmark: number;
  volatilitySizeCap: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  trailingStopActivatePct: number;
  trailingTpPct: number;
  trailingTpActivatePct: number;
  cooldownMinutes: number;
  feePct: number;
  dcaEnabled: boolean;
  dcaLevels: DcaLevel[];
  dcaMaxOrdersPerPosition: number;
  margin: MarginConfig;
  rsiShortEntryFloor: number;
  mm: MmConfig;
  arb: ArbConfig;
  triggers: TriggerRule[];
  strategyPools: Record<string, StrategySpec>;
  aiAdvisor: { apiKey: string; baseUrl: string; model: string; minIntervalMs: number; contextBars: number } | null;
  telegramBotToken: string;
  telegramChatId: string;
  dailyReportTime: string;
  dbPath: string;
}

function parseSymbols(raw: string, quote: QuoteCurrency): SymbolPair[] {
  const pairs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const result: SymbolPair[] = [];
  for (const pair of pairs) {
    const [src, dst] = pair.split("/").map((s) => s.trim().toLowerCase());
    if (!src || !dst) {
      throw new Error(`Invalid symbol pair "${pair}". Expected format src/dst, e.g. btc/rls`);
    }
    const key = `${src}/${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ src, dst, key, market: `${src}-${dst}`.toUpperCase() });
  }
  if (result.length === 0) {
    throw new Error("SYMBOLS must contain at least one pair");
  }
  const hasQuoteMarket = result.some((p) => p.dst === quote);
  if (!hasQuoteMarket) {
    throw new Error(`At least one symbol pair must be denominated in quote currency "${quote}"`);
  }
  return result;
}

function parseDcaLevels(raw: string): DcaLevel[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("DCA_LEVELS must be a JSON array, e.g. [{\"belowPct\":5,\"buyPct\":5}]");
  }
  const levels = parsed.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const belowPct = Number(e.belowPct);
    const buyPct = Number(e.buyPct);
    if (!Number.isFinite(belowPct) || belowPct <= 0 || !Number.isFinite(buyPct) || buyPct <= 0) {
      throw new Error(`DCA_LEVELS[${i}] needs positive belowPct and buyPct`);
    }
    return { belowPct, buyPct };
  });
  levels.sort((a, b) => a.belowPct - b.belowPct);
  return levels;
}

const triggerSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  when: z.object({
    type: z.enum(["rsi_below", "rsi_above", "price_below", "price_above", "sentiment_below", "sentiment_above"]),
    value: z.number(),
  }),
  then: z.object({
    type: z.enum(["notify", "halt"]),
    message: z.string().optional(),
  }),
});

function parseTriggers(raw: string): TriggerRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TRIGGERS must be a JSON array, e.g. [{\"id\":\"btc-dip\",\"symbol\":\"btc/rls\",\"when\":{\"type\":\"rsi_below\",\"value\":25},\"then\":{\"type\":\"notify\"}}]");
  }
  const result = z.array(triggerSchema).parse(parsed);
  const seen = new Set<string>();
  for (const rule of result) {
    if (seen.has(rule.id)) {
      throw new Error(`TRIGGERS contains a duplicate rule id "${rule.id}"`);
    }
    seen.add(rule.id);
  }
  return result;
}

function parseArbSymbols(raw: string, symbolKeys: Set<string>): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ARB_SYMBOLS must be a JSON object mapping a bot symbol to a second-exchange symbol, e.g. {\"btc/rls\":\"btcusdt\"}");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ARB_SYMBOLS must be a JSON object mapping a bot symbol to a second-exchange symbol");
  }
  const result: Record<string, string> = {};
  for (const [symbol, arbSymbol] of Object.entries(parsed as Record<string, unknown>)) {
    if (!symbolKeys.has(symbol)) {
      throw new Error(`ARB_SYMBOLS references symbol "${symbol}" which is not in SYMBOLS`);
    }
    const target = String(arbSymbol ?? "").trim();
    if (!target) {
      throw new Error(`ARB_SYMBOLS["${symbol}"] needs a non-empty second-exchange symbol`);
    }
    result[symbol] = target;
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = envSchema.parse(env);
  const symbols = parseSymbols(parsed.SYMBOLS, parsed.QUOTE_CURRENCY);
  const hours = parsed.SENTIMENT_WINDOW_HOURS;
  const halfLife = parsed.SENTIMENT_HALF_LIFE_HOURS;
  const dcaLevels = parseDcaLevels(parsed.DCA_LEVELS);
  const triggers = parseTriggers(parsed.TRIGGERS);
  const strategyPools = parseStrategyPools(parsed.STRATEGY_POOLS);
  const symbolKeys = new Set(symbols.map((s) => s.key));
  for (const rule of triggers) {
    if (!symbolKeys.has(rule.symbol)) {
      throw new Error(`TRIGGERS rule "${rule.id}" references symbol "${rule.symbol}" which is not in SYMBOLS`);
    }
  }
  for (const symbol of Object.keys(strategyPools)) {
    if (!symbolKeys.has(symbol)) {
      throw new Error(`STRATEGY_POOLS references symbol "${symbol}" which is not in SYMBOLS`);
    }
  }
  const usesAi = Object.values(strategyPools).some((spec) => spec.kind === "ai");
  const aiApiKey = parsed.USER_LLM_API_KEY.trim();
  if (usesAi && !aiApiKey) {
    throw new Error('STRATEGY_POOLS uses the "ai" strategy but USER_LLM_API_KEY is not set');
  }
  const usesMm = Object.values(strategyPools).some((spec) => spec.kind === "mm");
  if (usesMm && !parsed.MM_ENABLED) {
    throw new Error('STRATEGY_POOLS uses the "mm" strategy but MM_ENABLED is not set');
  }
  const usesArb = Object.values(strategyPools).some((spec) => spec.kind === "arb");
  if (usesArb && !parsed.ARB_ENABLED) {
    throw new Error('STRATEGY_POOLS uses the "arb" strategy but ARB_ENABLED is not set');
  }
  if (parsed.ARB_ENABLED && !parsed.DRY_RUN && (!parsed.USER_ARB_API_KEY.trim() || !parsed.USER_ARB_API_SECRET.trim())) {
    throw new Error("ARB_ENABLED requires USER_ARB_API_KEY and USER_ARB_API_SECRET when not in dry-run mode");
  }
  const marginSymbols = parsed.MARGIN_SYMBOLS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const symbol of marginSymbols) {
    if (!symbolKeys.has(symbol)) {
      throw new Error(`MARGIN_SYMBOLS references symbol "${symbol}" which is not in SYMBOLS`);
    }
  }
  const mmSymbols = parsed.MM_SYMBOLS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const symbol of mmSymbols) {
    if (!symbolKeys.has(symbol)) {
      throw new Error(`MM_SYMBOLS references symbol "${symbol}" which is not in SYMBOLS`);
    }
  }
  const arbSymbols = parseArbSymbols(parsed.ARB_SYMBOLS, symbolKeys);
  const margin: MarginConfig = {
    enabled: parsed.MARGIN_ENABLED,
    leverage: parsed.MARGIN_LEVERAGE,
    maxShortPct: parsed.MARGIN_MAX_SHORT_PCT,
    symbols: marginSymbols,
    stopLossPct: parsed.MARGIN_STOP_LOSS_PCT,
    takeProfitPct: parsed.MARGIN_TAKE_PROFIT_PCT,
  };
  const mm: MmConfig = {
    enabled: parsed.MM_ENABLED,
    symbols: mmSymbols,
    spreadPct: parsed.MM_SPREAD_PCT,
    orderValue: parsed.MM_ORDER_VALUE,
    maxInventoryValue: parsed.MM_MAX_INVENTORY_VALUE,
    stopLossPct: parsed.MM_STOP_LOSS_PCT,
    cooldownMs: parsed.MM_COOLDOWN_SECONDS * 1000,
    maxQuoteAgeMs: parsed.MM_MAX_QUOTE_AGE_SECONDS * 1000,
    minOrderValue: parsed.MM_MIN_ORDER_VALUE,
  };
  const arb: ArbConfig = {
    enabled: parsed.ARB_ENABLED,
    exchange: parsed.ARB_EXCHANGE.trim().toLowerCase(),
    symbols: arbSymbols,
    fxRate: parsed.ARB_FX_RATE,
    minProfitPct: parsed.ARB_MIN_PROFIT_PCT,
    maxNotionalPct: parsed.ARB_MAX_NOTIONAL_PCT,
    cooldownMs: parsed.ARB_COOLDOWN_SECONDS * 1000,
    apiKey: parsed.USER_ARB_API_KEY.trim(),
    apiSecret: parsed.USER_ARB_API_SECRET.trim(),
  };
  return {
    botName: parsed.BOT_NAME.trim() || "default",
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    nobitexApiKey: parsed.NOBITEX_API_KEY.trim(),
    nobitexBaseUrl: parsed.NOBITEX_BASE_URL.replace(/\/$/, ""),
    dryRun: parsed.DRY_RUN,
    tradingEnabled: parsed.TRADING_ENABLED,
    quoteCurrency: parsed.QUOTE_CURRENCY,
    symbols,
    rsiPeriod: parsed.RSI_PERIOD,
    rsiOverbought: parsed.RSI_OVERBOUGHT,
    rsiEntryUpper: parsed.RSI_ENTRY_UPPER,
    sentimentEntryThreshold: parsed.SENTIMENT_ENTRY_THRESHOLD,
    sentimentExitThreshold: parsed.SENTIMENT_EXIT_THRESHOLD,
    sentimentWindowMs: hours * 60 * 60 * 1000,
    sentimentHalfLifeMs: halfLife * 60 * 60 * 1000,
    sentimentMinConfidence: parsed.SENTIMENT_MIN_CONFIDENCE,
    sentimentWebhookPort: parsed.SENTIMENT_WEBHOOK_PORT,
    sentimentWebhookToken: parsed.SENTIMENT_WEBHOOK_TOKEN,
    sentimentJsonFeed: parsed.SENTIMENT_JSON_FEED,
    tradingViewEnabled: parsed.TRADINGVIEW_ENABLED,
    pricePollMs: parsed.PRICE_POLL_SECONDS * 1000,
    seriesMaxPoints: parsed.SERIES_MAX_POINTS,
    seedSeriesFromTrades: parsed.SEED_SERIES_FROM_TRADES,
    virtualStartEquity: parsed.VIRTUAL_START_EQUITY,
    maxPositionSizePct: parsed.MAX_POSITION_SIZE_PCT,
    maxTotalExposurePct: parsed.MAX_TOTAL_EXPOSURE_PCT,
    maxDailyLossPct: parsed.MAX_DAILY_LOSS_PCT,
    maxTradesPerDay: parsed.MAX_TRADES_PER_DAY,
    minOrderValue: parsed.MIN_ORDER_VALUE,
    volatilityMax: parsed.VOLATILITY_MAX,
    volatilityBenchmark: parsed.VOLATILITY_BENCHMARK,
    volatilitySizeCap: parsed.VOLATILITY_SIZE_CAP,
    stopLossPct: parsed.STOP_LOSS_PCT,
    takeProfitPct: parsed.TAKE_PROFIT_PCT,
    trailingStopPct: parsed.TRAILING_STOP_PCT,
    trailingStopActivatePct: parsed.TRAILING_STOP_ACTIVATE_PCT,
    trailingTpPct: parsed.TRAILING_TP_PCT,
    trailingTpActivatePct: parsed.TRAILING_TP_ACTIVATE_PCT,
    cooldownMinutes: parsed.COOLDOWN_MINUTES,
    feePct: parsed.FEE_PCT,
    dcaEnabled: parsed.DCA_ENABLED,
    dcaLevels,
    dcaMaxOrdersPerPosition: parsed.DCA_MAX_ORDERS_PER_POSITION,
    margin,
    rsiShortEntryFloor: parsed.RSI_SHORT_ENTRY_FLOOR,
    mm,
    arb,
    triggers,
    strategyPools,
    aiAdvisor: aiApiKey
      ? {
          apiKey: aiApiKey,
          baseUrl: parsed.USER_LLM_BASE_URL.replace(/\/$/, ""),
          model: parsed.USER_LLM_MODEL.trim(),
          minIntervalMs: parsed.AI_ADVISOR_MIN_INTERVAL_SECONDS * 1000,
          contextBars: parsed.AI_ADVISOR_CONTEXT_BARS,
        }
      : null,
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN.trim(),
    telegramChatId: parsed.TELEGRAM_CHAT_ID.trim(),
    dailyReportTime: parsed.DAILY_REPORT_TIME,
    dbPath: parsed.DB_PATH,
  };
}

export function loadConfigs(env: NodeJS.ProcessEnv = process.env): BotConfig[] {
  const rawBots = env.BOTS_JSON ?? "";
  if (!rawBots.trim()) {
    return [loadConfig(env)];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBots);
  } catch {
    throw new Error("BOTS_JSON must be a JSON array of env override objects");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BOTS_JSON must be a non-empty JSON array, e.g. [{\"SYMBOLS\":\"btc/rls\",\"DB_PATH\":\"./data/bot-btc.db\",\"SENTIMENT_WEBHOOK_PORT\":0}]");
  }
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`BOTS_JSON[${i}] must be an object of env overrides`);
    }
    return loadConfig({ ...env, ...(entry as Record<string, string>) });
  });
}
