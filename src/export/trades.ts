import { loadConfig } from "../config.js";
import { AuditDb } from "../db.js";

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

function escapeCsv(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function dateToTs(date: string, endOfDay: boolean): string {
  const match = /^(\d{4}-\d{2}-\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Invalid date "${date}". Expected YYYY-MM-DD`);
  }
  return endOfDay ? `${date}T23:59:59.999Z` : `${date}T00:00:00.000Z`;
}

function main(): void {
  process.stdout.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
    throw err;
  });

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = new AuditDb(config.dbPath);

  const kind = args.kind ?? "trades";
  const toTs = args.to ? dateToTs(args.to, true) : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const fromTs = args.from ? dateToTs(args.from, false) : "1970-01-01T00:00:00.000Z";

  const format = (v: number): string => {
    if (Number.isInteger(v)) return String(v);
    const rounded = Math.round(v);
    if (Math.abs(v - rounded) < 1e-4) return String(rounded);
    return v.toFixed(8).replace(/\.?0+$/, "");
  };

  if (kind === "positions") {
    const positions = db.closedPositionsBetween(fromTs, toTs);
    console.log("open_ts,close_ts,symbol,amount,entry_price,exit_price,realized_pnl,exit_reason");
    for (const p of positions) {
      console.log(
        [
          p.openTs,
          p.closeTs ?? "",
          p.symbol,
          format(p.amount),
          format(p.entryPrice),
          p.closePrice !== null ? format(p.closePrice) : "",
          p.realizedPnl !== null ? format(p.realizedPnl) : "",
          p.exitReason ?? "",
        ]
          .map(escapeCsv)
          .join(",")
      );
    }
  } else {
    const trades = db.tradesBetween(fromTs, toTs);
    console.log("ts,symbol,side,amount,price,total,fee");
    for (const t of trades) {
      console.log(
        [t.ts, t.symbol, t.side, format(t.amount), format(t.price), format(t.total), format(t.fee)].map(escapeCsv).join(",")
      );
    }
  }

  db.close();
}

main();
