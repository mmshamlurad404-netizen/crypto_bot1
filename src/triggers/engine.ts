export type TriggerConditionType =
  | "rsi_below"
  | "rsi_above"
  | "price_below"
  | "price_above"
  | "sentiment_below"
  | "sentiment_above";

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
}

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
