import { readFileSync } from "node:fs";
import { NobitexClient } from "../exchange/nobitex.js";
import { toUdfSymbol } from "../market/priceFeed.js";
import { SymbolPair, SentimentInput } from "../types.js";

export interface BacktestBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MAX_BARS_PER_REQUEST = 500;

export async function loadHistory(
  client: NobitexClient,
  pair: SymbolPair,
  days: number,
  resolutionMinutes: number
): Promise<BacktestBar[]> {
  const symbol = toUdfSymbol(pair);
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 24 * 60 * 60;
  const capDays = Math.max(1, Math.floor((MAX_BARS_PER_REQUEST * resolutionMinutes) / 1440));

  const bars: BacktestBar[] = [];
  const seen = new Set<number>();
  let windowEnd = to;
  while (windowEnd > from) {
    const windowStart = Math.max(from, windowEnd - capDays * 24 * 60 * 60);
    const data = await client.udfHistory(symbol, resolutionMinutes, windowStart, windowEnd);
    if (data.s !== "ok") {
      throw new Error(`UDF history failed for ${pair.key}: status "${data.s}"`);
    }
    if (data.t.length === 0) break;
    let earliest = Infinity;
    for (let i = 0; i < data.t.length; i++) {
      const ts = data.t[i]! * 1000;
      if (ts < from) continue;
      if (seen.has(ts)) continue;
      seen.add(ts);
      earliest = Math.min(earliest, ts);
      bars.push({
        ts,
        open: data.o[i]!,
        high: data.h[i]!,
        low: data.l[i]!,
        close: data.c[i]!,
        volume: data.v[i]!,
      });
    }
    if (data.t.length < MAX_BARS_PER_REQUEST) break;
    windowEnd = Math.floor((earliest === Infinity ? windowStart : earliest) / 1000);
  }
  return bars.sort((a, b) => a.ts - b.ts);
}

export function loadSentimentFile(path: string): SentimentInput[] {
  const content = readFileSync(path, "utf8");
  const events: SentimentInput[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as SentimentInput;
    if (!parsed.account || !parsed.symbol || typeof parsed.sentiment !== "number") continue;
    events.push(parsed);
  }
  return events;
}
