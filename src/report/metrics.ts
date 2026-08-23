import { AuditDb } from "../db.js";

export interface MetricsRange {
  fromTs?: string;
  toTs?: string;
}

export interface PerformanceMetrics {
  fromTs: string;
  toTs: string;
  snapshots: number;
  trades: number;
  roundTrips: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  startEquity: number | null;
  endEquity: number | null;
  returnPct: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  avgExposurePct: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function computeMetrics(db: AuditDb, opts: MetricsRange = {}): PerformanceMetrics {
  const fromTs = opts.fromTs ?? isoDaysAgo(30);
  const toTs = opts.toTs ?? new Date(Date.now() + DAY_MS).toISOString();

  const positions = db.closedPositionsBetween(fromTs, toTs);
  const trades = db.tradesBetween(fromTs, toTs);
  const snapshots = db.snapshotsBetween(fromTs, toTs);

  const wins = positions.filter((p) => (p.realizedPnl ?? 0) > 0);
  const losses = positions.filter((p) => (p.realizedPnl ?? 0) <= 0);
  const grossProfit = wins.reduce((a, p) => a + (p.realizedPnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, p) => a + (p.realizedPnl ?? 0), 0));
  const netPnl = grossProfit - grossLoss;
  const roundTrips = positions.length;

  let maxDrawdownPct: number | null = null;
  let sharpe: number | null = null;
  let avgExposurePct: number | null = null;
  let startEquity: number | null = null;
  let endEquity: number | null = null;
  let returnPct: number | null = null;

  if (snapshots.length > 0) {
    let peak = -Infinity;
    let maxDD = 0;
    let exposureSum = 0;
    for (const s of snapshots) {
      if (s.equity > peak) peak = s.equity;
      if (peak > 0) maxDD = Math.max(maxDD, (peak - s.equity) / peak);
      if (s.equity > 0) exposureSum += s.positionsValue / s.equity;
    }
    maxDrawdownPct = maxDD * 100;
    avgExposurePct = (exposureSum / snapshots.length) * 100;

    startEquity = snapshots[0]!.equity;
    endEquity = snapshots[snapshots.length - 1]!.equity;
    if (startEquity > 0) returnPct = ((endEquity - startEquity) / startEquity) * 100;

    const dailyReturns: number[] = [];
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]!.equity;
      if (prev > 0) dailyReturns.push((snapshots[i]!.equity - prev) / prev);
    }
    if (dailyReturns.length >= 2) {
      const std = sampleStd(dailyReturns);
      if (std > 0) sharpe = (mean(dailyReturns) / std) * Math.sqrt(365);
    }
  }

  const avgWin = wins.length > 0 ? grossProfit / wins.length : null;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : null;

  return {
    fromTs,
    toTs,
    snapshots: snapshots.length,
    trades: trades.length,
    roundTrips,
    wins: wins.length,
    losses: losses.length,
    winRatePct: roundTrips > 0 ? (wins.length / roundTrips) * 100 : 0,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    avgWin,
    avgLoss,
    avgWinPct: avgWin !== null && startEquity !== null && startEquity > 0 ? (avgWin / startEquity) * 100 : null,
    avgLossPct: avgLoss !== null && startEquity !== null && startEquity > 0 ? (avgLoss / startEquity) * 100 : null,
    startEquity,
    endEquity,
    returnPct,
    maxDrawdownPct,
    sharpe,
    avgExposurePct,
  };
}
