import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { NobitexClient } from "../exchange/nobitex.js";
import { loadHistory, loadSentimentFile, BacktestBar } from "./data.js";
import { runBacktest } from "./engine.js";
import { SentimentInput } from "../types.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function formatRial(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const pairKey = args.symbol ?? config.symbols[0]!.key;
  const pair = config.symbols.find((s) => s.key === pairKey);
  if (!pair) {
    console.error(`Unknown symbol "${pairKey}". Configured: ${config.symbols.map((s) => s.key).join(", ")}`);
    process.exit(1);
  }

  const days = Math.max(1, Math.min(Number(args.days ?? 90), 3650));
  const resolution = Math.max(1, Number(args.resolution ?? 60));
  const startEquity = args["start-equity"] !== undefined ? Number(args["start-equity"]) : config.virtualStartEquity;
  const hasConstant = args.sentiment !== undefined;
  const hasFile = args["sentiment-file"] !== undefined;

  if (args.help === "true") {
    console.log(`Usage: npx tsx src/backtest/run.ts [options]

Options:
  --symbol <pair>        symbol key from SYMBOLS (default: first configured)
  --days <n>             days of history to fetch (default 90)
  --resolution <min>     bar size in minutes (default 60; exchange keeps ~500 bars,
                         60m≈21d, 240m≈83d)
  --sentiment <value>    constant sentiment in [-1,1] for the whole period
  --sentiment-file <p>   JSONL of {account, symbol, sentiment, confidence?, timestamp?}
  --start-equity <rls>   virtual starting equity (default VIRTUAL_START_EQUITY)
  --json                 emit machine-readable JSON
  --verbose              list each round trip

Requires either --sentiment or --sentiment-file.`);
    return;
  }
  if (!hasConstant && !hasFile) {
    console.error(
      "Missing sentiment source. Pass --sentiment <value> (constant in [-1,1]) or --sentiment-file <path> (JSONL of {account, symbol, sentiment, confidence?, timestamp?})."
    );
    process.exit(1);
  }
  if (hasConstant) {
    const value = Number(args.sentiment);
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      console.error("--sentiment must be a number in [-1, 1]");
      process.exit(1);
    }
  }
  if (args.days !== undefined && !Number.isFinite(days)) {
    console.error("--days must be a number");
    process.exit(1);
  }
  if (args.resolution !== undefined && !Number.isFinite(resolution)) {
    console.error("--resolution must be a number (minutes)");
    process.exit(1);
  }

  logger.info(
    { pair: pair.key, days, resolution, startEquity, sentiment: hasConstant ? `constant ${args.sentiment}` : `file ${args["sentiment-file"]}` },
    "backtest: loading history"
  );

  const client = new NobitexClient(config.nobitexBaseUrl, config.nobitexApiKey);
  let bars: BacktestBar[];
  try {
    bars = await loadHistory(client, pair, days, resolution);
  } catch (err) {
    console.error(`Failed to load history for ${pair.key}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (bars.length === 0) {
    console.error("No bars returned by the exchange for this range.");
    process.exit(1);
  }
  const spanDays = (bars[bars.length - 1]!.ts - bars[0]!.ts) / 86_400_000;
  if (spanDays < days - 1) {
    logger.warn(
      { requestedDays: days, bars: bars.length, spanDays: spanDays.toFixed(1) },
      "backtest: exchange retained fewer bars than requested (~500-bar history cap); use a coarser --resolution for a longer span"
    );
  }

  let sentimentEvents: SentimentInput[];
  if (hasConstant) {
    const value = Number(args.sentiment);
    sentimentEvents = bars.map((b) => ({ account: "constant", symbol: pair.src, sentiment: value, confidence: 1, timestamp: b.ts }));
  } else {
    sentimentEvents = loadSentimentFile(args["sentiment-file"]!);
  }

  logger.info({ bars: bars.length }, "backtest: running");
  const result = await runBacktest({ config, pair, bars, sentimentEvents, startEquity });

  if (args.json === "true") {
    console.log(JSON.stringify(result));
    return;
  }

  const m = result.metrics;
  const pf = m.profitFactor === null ? "n/a" : m.profitFactor === Infinity ? "inf" : m.profitFactor.toFixed(2);
  const fmtPct = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(2)}%`);
  console.log("");
  console.log(`Backtest ${pair.key} | ${days}d | ${resolution}m bars | ${m.bars} bars`);
  console.log(`Sentiment: ${hasConstant ? "constant " + args.sentiment : "file " + args["sentiment-file"]}`);
  console.log(`Start equity: ${formatRial(m.startEquity)} rls | End equity: ${formatRial(m.endEquity)} rls | Return: ${m.totalReturnPct.toFixed(2)}%`);
  console.log(`Fills: ${m.fills} (${m.buys} buy / ${m.sells} sell) | Round trips: ${m.roundTrips}`);
  console.log(`Win rate: ${m.winRatePct.toFixed(1)}% (${m.wins}W / ${m.losses}L)`);
  console.log(`Profit factor: ${pf}`);
  console.log(`Gross profit: ${formatRial(m.grossProfit)} rls | Gross loss: ${formatRial(m.grossLoss)} rls`);
  console.log(`Max drawdown: ${m.maxDrawdownPct.toFixed(2)}% | Avg win: ${fmtPct(m.avgWinPct)} | Avg loss: ${fmtPct(m.avgLossPct)}`);
  if (args.verbose === "true" && result.roundTrips.length > 0) {
    console.log("");
    for (const t of result.roundTrips) {
      console.log(`${t.closeTs} ${t.symbol} entry=${formatRial(t.entryPrice)} exit=${formatRial(t.exitPrice)} pnl=${formatRial(t.realizedPnl)} [${t.reason}]`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
