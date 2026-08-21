export interface IndicatorResult {
  rsi: number | null;
  volatility: number | null;
  price: number | null;
}

export function calculateRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateVolatility(closes: number[], lookback = 60): number | null {
  if (closes.length < 2) return null;
  const start = Math.max(0, closes.length - lookback);
  const window = closes.slice(start);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    if (prev <= 0) continue;
    returns.push(Math.log(window[i]! / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

export function computeIndicators(closes: number[], rsiPeriod: number, volLookback = 60): IndicatorResult {
  return {
    rsi: calculateRSI(closes, rsiPeriod),
    volatility: calculateVolatility(closes, volLookback),
    price: closes.length > 0 ? closes[closes.length - 1]! : null,
  };
}
