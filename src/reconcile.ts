import { pathToFileURL } from "node:url";
import { AuditDb } from "./db.js";
import { NobitexClient } from "./exchange/nobitex.js";
import { PriceFeed } from "./market/priceFeed.js";
import { PortfolioManager } from "./portfolio/manager.js";
import { loadConfigs } from "./config.js";
import { createLogger } from "./logger.js";
import { SymbolPair } from "./types.js";

export interface BaseExpectation {
  currency: string;
  held: number;
  blockedByOpenSells: number;
  sources: { symbol: string; amount: number }[];
}

export interface ReconcileRow {
  currency: string;
  expectedActive: number;
  actualActive: number;
  diff: number;
  sourceSymbols: string[];
}

export interface ReconcileReport {
  rows: ReconcileRow[];
  ok: boolean;
}

const TOLERANCE = 1e-6;

function baseOf(symbol: string): string {
  return symbol.split("/")[0]!.toLowerCase();
}

export function deriveSpotExpectation(db: AuditDb): BaseExpectation[] {
  const byBase = new Map<string, BaseExpectation>();
  for (const pos of db.openPositions()) {
    const base = baseOf(pos.symbol);
    let e = byBase.get(base);
    if (!e) {
      e = { currency: base, held: 0, blockedByOpenSells: 0, sources: [] };
      byBase.set(base, e);
    }
    e.held += pos.amount;
    e.sources.push({ symbol: pos.symbol, amount: pos.amount });
  }
  for (const order of db.openOrders()) {
    if (order.side !== "sell") continue;
    const base = baseOf(order.symbol);
    let e = byBase.get(base);
    if (!e) {
      e = { currency: base, held: 0, blockedByOpenSells: 0, sources: [] };
      byBase.set(base, e);
    }
    e.blockedByOpenSells += order.amount;
  }
  return [...byBase.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function reconcile(opts: {
  db: AuditDb;
  symbols: SymbolPair[];
  holdings: Map<string, number>;
}): Promise<ReconcileReport> {
  const expectations = deriveSpotExpectation(opts.db);
  const configuredBases = [...new Set(opts.symbols.map((s) => s.src.toLowerCase()))];
  const rows: ReconcileRow[] = [];
  for (const base of configuredBases) {
    const exp = expectations.find((e) => e.currency === base);
    const expected = exp ? exp.held - exp.blockedByOpenSells : 0;
    const actual = opts.holdings.get(base) ?? 0;
    rows.push({
      currency: base,
      expectedActive: expected,
      actualActive: actual,
      diff: actual - expected,
      sourceSymbols: exp ? exp.sources.map((s) => s.symbol) : [],
    });
  }
  const ok = rows.every((r) => Math.abs(r.diff) <= TOLERANCE);
  return { rows, ok };
}

export function formatReport(report: ReconcileReport): string {
  const lines = report.rows.map(
    (r) => `${r.currency}: expected active ${r.expectedActive.toFixed(8)} / wallet active ${r.actualActive.toFixed(8)} / diff ${r.diff >= 0 ? "+" : ""}${r.diff.toFixed(8)} (${r.sourceSymbols.join(", ") || "no open positions"})`
  );
  lines.push(report.ok ? "RECONCILED OK" : "DRIFT DETECTED — expected and exchange wallets diverge; manual review required");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const configs = loadConfigs();
  const logger = createLogger(configs[0]!.logLevel);
  let failed = false;
  for (const config of configs) {
    const db = new AuditDb(config.dbPath);
    const label = config.botName;
    if (config.dryRun) {
      logger.info({ bot: label }, "reconcile skipped: DRY_RUN=true (nothing is live against the exchange)");
      continue;
    }
    try {
      const client = new NobitexClient(config.nobitexBaseUrl, config.nobitexApiKey);
      const priceFeed = new PriceFeed(client, config.symbols, config.seriesMaxPoints, false);
      const portfolio = new PortfolioManager(db, client, priceFeed, config.symbols, config.quoteCurrency, false, config.virtualStartEquity);
      await portfolio.refresh();
      const report = await reconcile({ db, symbols: config.symbols, holdings: portfolio.getHoldings() });
      console.log(`[${label}]`);
      console.log(formatReport(report));
      if (!report.ok) failed = true;
    } catch (err) {
      logger.error({ bot: label, error: (err as Error).message }, "reconcile failed");
      failed = true;
    } finally {
      db.close();
    }
  }
  process.exit(failed ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main();
}
