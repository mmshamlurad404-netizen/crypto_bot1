export type TriggerConditionType =
  | "rsi_below"
  | "rsi_above"
  | "price_below"
  | "price_above"
  | "sentiment_below"
  | "sentiment_above"
  | "volatility_below"
  | "volatility_above"
  | "atr_pct_below"
  | "atr_pct_above"
  | "stoch_k_below"
  | "stoch_k_above"
  | "stoch_d_below"
  | "stoch_d_above"
  | "macd_hist_pct_below"
  | "macd_hist_pct_above";

export type TriggerActionType = "notify" | "halt";

export interface TriggerCondition {
  type: TriggerConditionType;
  value: number;
}

export interface TriggerAction {
  type: TriggerActionType;
  message?: string;
}

export interface TriggerRule {
  id: string;
  symbol: string;
  when: TriggerCondition;
  then: TriggerAction;
}

export interface TriggerInput {
  symbol: string;
  price: number | null;
  rsi: number | null;
  sentiment: number | null;
  volatility?: number | null;
  atrPct?: number | null;
  stochK?: number | null;
  stochD?: number | null;
  macdHistPct?: number | null;
}

export const indicatorTriggerTypes = new Set<TriggerConditionType>([
  "rsi_below",
  "rsi_above",
  "volatility_below",
  "volatility_above",
  "atr_pct_below",
  "atr_pct_above",
  "stoch_k_below",
  "stoch_k_above",
  "stoch_d_below",
  "stoch_d_above",
  "macd_hist_pct_below",
  "macd_hist_pct_above",
]);

export const richIndicatorTriggerTypes = new Set<TriggerConditionType>([
  "volatility_below",
  "volatility_above",
  "atr_pct_below",
  "atr_pct_above",
  "stoch_k_below",
  "stoch_k_above",
  "stoch_d_below",
  "stoch_d_above",
  "macd_hist_pct_below",
  "macd_hist_pct_above",
]);

export interface TriggerEvent {
  ruleId: string;
  symbol: string;
  actionType: TriggerActionType;
  message: string;
}

function conditionMet(cond: TriggerCondition, input: TriggerInput): boolean {
  switch (cond.type) {
    case "rsi_below":
      return input.rsi !== null && input.rsi < cond.value;
    case "rsi_above":
      return input.rsi !== null && input.rsi > cond.value;
    case "price_below":
      return input.price !== null && input.price < cond.value;
    case "price_above":
      return input.price !== null && input.price > cond.value;
    case "sentiment_below":
      return input.sentiment !== null && input.sentiment < cond.value;
    case "sentiment_above":
      return input.sentiment !== null && input.sentiment > cond.value;
    case "volatility_below":
      return input.volatility !== null && input.volatility !== undefined && input.volatility < cond.value;
    case "volatility_above":
      return input.volatility !== null && input.volatility !== undefined && input.volatility > cond.value;
    case "atr_pct_below":
      return input.atrPct !== null && input.atrPct !== undefined && input.atrPct < cond.value;
    case "atr_pct_above":
      return input.atrPct !== null && input.atrPct !== undefined && input.atrPct > cond.value;
    case "stoch_k_below":
      return input.stochK !== null && input.stochK !== undefined && input.stochK < cond.value;
    case "stoch_k_above":
      return input.stochK !== null && input.stochK !== undefined && input.stochK > cond.value;
    case "stoch_d_below":
      return input.stochD !== null && input.stochD !== undefined && input.stochD < cond.value;
    case "stoch_d_above":
      return input.stochD !== null && input.stochD !== undefined && input.stochD > cond.value;
    case "macd_hist_pct_below":
      return input.macdHistPct !== null && input.macdHistPct !== undefined && input.macdHistPct < cond.value;
    case "macd_hist_pct_above":
      return input.macdHistPct !== null && input.macdHistPct !== undefined && input.macdHistPct > cond.value;
  }
}

function currentValue(cond: TriggerCondition, input: TriggerInput): number | null {
  switch (cond.type) {
    case "rsi_below":
    case "rsi_above":
      return input.rsi;
    case "price_below":
    case "price_above":
      return input.price;
    case "sentiment_below":
    case "sentiment_above":
      return input.sentiment;
    case "volatility_below":
    case "volatility_above":
      return input.volatility ?? null;
    case "atr_pct_below":
    case "atr_pct_above":
      return input.atrPct ?? null;
    case "stoch_k_below":
    case "stoch_k_above":
      return input.stochK ?? null;
    case "stoch_d_below":
    case "stoch_d_above":
      return input.stochD ?? null;
    case "macd_hist_pct_below":
    case "macd_hist_pct_above":
      return input.macdHistPct ?? null;
  }
}

function buildMessage(rule: TriggerRule, input: TriggerInput): string {
  if (rule.then.message) {
    return rule.then.message.replaceAll("{symbol}", input.symbol);
  }
  const current = currentValue(rule.when, input);
  const op = rule.when.type.endsWith("_below") ? "<" : ">";
  const cur = current === null ? "n/a" : String(Math.round(current * 100) / 100);
  return `Trigger "${rule.id}" fired on ${input.symbol}: ${rule.when.type} ${cur} ${op} ${rule.when.value}`;
}

export class TriggerEngine {
  private rules: TriggerRule[];
  private prevTruth: Map<string, boolean> = new Map();

  constructor(rules: TriggerRule[]) {
    this.rules = rules;
  }

  get count(): number {
    return this.rules.length;
  }

  reset(): void {
    this.prevTruth.clear();
  }

  evaluate(input: TriggerInput): TriggerEvent[] {
    const events: TriggerEvent[] = [];
    for (const rule of this.rules) {
      if (rule.symbol !== input.symbol) continue;
      const ok = conditionMet(rule.when, input);
      const key = rule.id;
      const prev = this.prevTruth.get(key) ?? false;
      this.prevTruth.set(key, ok);
      if (ok && !prev) {
        events.push({ ruleId: rule.id, symbol: input.symbol, actionType: rule.then.type, message: buildMessage(rule, input) });
      }
    }
    return events;
  }
}
