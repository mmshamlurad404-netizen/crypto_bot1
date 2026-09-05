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

export function calculateSMA(closes: number[], period: number): number | null {
  if (closes.length < period || period <= 0) return null;
  const window = closes.slice(closes.length - period);
  return window.reduce((a, b) => a + b, 0) / period;
}

export function calculateEMA(closes: number[], period: number): number | null {
  if (closes.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
  }
  return ema;
}

export function emaSeries(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period || period <= 0) return result;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

export const DEFAULT_MACD_FAST = 12;
export const DEFAULT_MACD_SLOW = 26;
export const DEFAULT_MACD_SIGNAL = 9;

export interface MacdResult {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export function calculateMACD(closes: number[], fast = DEFAULT_MACD_FAST, slow = DEFAULT_MACD_SLOW, signal = DEFAULT_MACD_SIGNAL): MacdResult {
  const fastEma = emaSeries(closes, fast);
  const slowEma = emaSeries(closes, slow);
  const macdSeries: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      macdSeries.push((fastEma[i] as number) - (slowEma[i] as number));
    } else {
      macdSeries.push(null);
    }
  }
  const first = macdSeries.findIndex((v) => v !== null);
  if (first === -1) return { macd: null, signal: null, histogram: null };
  const validMacd = macdSeries.slice(first) as number[];
  if (validMacd.length < signal) return { macd: null, signal: null, histogram: null };
  const signalSeries = emaSeries(validMacd, signal);
  const last = validMacd.length - 1;
  const sig = signalSeries[last];
  if (sig === null || sig === undefined) return { macd: null, signal: null, histogram: null };
  const macd = validMacd[last]!;
  return { macd, signal: sig, histogram: macd - sig };
}

export const DEFAULT_BOLLINGER_PERIOD = 20;
export const DEFAULT_BOLLINGER_MULT = 2;

export interface BollingerResult {
  upper: number | null;
  middle: number | null;
  lower: number | null;
}

export function calculateBollinger(closes: number[], period = DEFAULT_BOLLINGER_PERIOD, mult = DEFAULT_BOLLINGER_MULT): BollingerResult {
  if (closes.length < period || period <= 0) return { upper: null, middle: null, lower: null };
  const window = closes.slice(closes.length - period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + mult * sd, middle: mean, lower: mean - mult * sd };
}

export const DEFAULT_STOCH_PERIOD = 14;
export const DEFAULT_STOCH_SMOOTH = 3;

export interface StochResult {
  k: number | null;
  d: number | null;
}

export function calculateStoch(closes: number[], period = DEFAULT_STOCH_PERIOD, smooth = DEFAULT_STOCH_SMOOTH): StochResult {
  if (closes.length < period) return { k: null, d: null };
  const kSeries: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const hi = Math.max(...window);
    const lo = Math.min(...window);
    const k = hi === lo ? 50 : ((closes[i]! - lo) / (hi - lo)) * 100;
    kSeries.push(k);
  }
  if (kSeries.length < smooth || smooth <= 0) return { k: null, d: null };
  const k = kSeries[kSeries.length - 1]!;
  const dWindow = kSeries.slice(kSeries.length - smooth);
  const d = dWindow.reduce((a, b) => a + b, 0) / dWindow.length;
  return { k, d };
}

export const DEFAULT_ATR_PROXY_PERIOD = 14;

export function calculateCloseRangePct(closes: number[], period = DEFAULT_ATR_PROXY_PERIOD): number | null {
  if (closes.length < period + 1) return null;
  const window = closes.slice(closes.length - period);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < window.length; i++) {
    const prev = i === 0 ? closes[closes.length - period - 1]! : window[i - 1]!;
    const cur = window[i]!;
    if (prev > 0 && cur > 0) {
      sum += Math.abs(cur - prev) / prev;
      count++;
    }
  }
  if (count === 0) return null;
  return (sum / count) * 100;
}

export interface RichIndicatorResult extends IndicatorResult {
  macd: number | null;
  macdSignal: number | null;
  macdHistPct: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  stochK: number | null;
  stochD: number | null;
  atrPct: number | null;
}

export function computeRichIndicators(
  closes: number[],
  rsiPeriod: number,
  volLookback = 60,
  macdFast = DEFAULT_MACD_FAST,
  macdSlow = DEFAULT_MACD_SLOW,
  macdSignal = DEFAULT_MACD_SIGNAL,
  bollPeriod = DEFAULT_BOLLINGER_PERIOD,
  bollMult = DEFAULT_BOLLINGER_MULT,
  stochPeriod = DEFAULT_STOCH_PERIOD,
  stochSmooth = DEFAULT_STOCH_SMOOTH,
  atrPeriod = DEFAULT_ATR_PROXY_PERIOD
): RichIndicatorResult {
  const base = computeIndicators(closes, rsiPeriod, volLookback);
  const macd = calculateMACD(closes, macdFast, macdSlow, macdSignal);
  const boll = calculateBollinger(closes, bollPeriod, bollMult);
  const stoch = calculateStoch(closes, stochPeriod, stochSmooth);
  const atrPct = calculateCloseRangePct(closes, atrPeriod);
  const price = base.price;
  return {
    ...base,
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistPct: macd.histogram !== null && price !== null && price > 0 ? (macd.histogram / price) * 100 : null,
    bollingerUpper: boll.upper,
    bollingerMiddle: boll.middle,
    bollingerLower: boll.lower,
    stochK: stoch.k,
    stochD: stoch.d,
    atrPct,
  };
}
