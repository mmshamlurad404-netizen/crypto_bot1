export type QuoteCurrency = "rls" | "usdt";

export interface SymbolPair {
  src: string;
  dst: string;
  key: string;
  market: string;
}

export interface MarketStat {
  isClosed: boolean;
  isClosedReason?: string | null;
  bestSell?: string | null;
  bestBuy?: string | null;
  volumeSrc?: string | null;
  volumeDst?: string | null;
  latest?: string | null;
  mark?: string | null;
  dayLow?: string | null;
  dayHigh?: string | null;
  dayOpen?: string | null;
  dayClose?: string | null;
  dayChange?: string | null;
}

export interface PricePoint {
  ts: number;
  price: number;
}

export type SignalAction = "BUY" | "SELL" | "HOLD" | "SHORT" | "COVER";

export interface SignalDecision {
  symbol: string;
  action: SignalAction;
  rsi: number | null;
  sentiment: number | null;
  price: number | null;
  reason: string;
  sizePct?: number;
  dca?: boolean;
}

export interface SentimentInput {
  account: string;
  symbol: string;
  sentiment: number;
  confidence?: number;
  note?: string;
  timestamp?: number;
}

export interface Position {
  id: number;
  symbol: string;
  openTs: string;
  entryPrice: number;
  amount: number;
  status: "open" | "closed";
  closeTs: string | null;
  closePrice: number | null;
  realizedPnl: number | null;
  exitReason: string | null;
  orderId: number | null;
}

export interface OrderRecord {
  id: number;
  ts: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  execution: "market" | "limit";
  kind: string;
  amount: number;
  price: number | null;
  status: "new" | "filled" | "canceled" | "failed";
  dryRun: boolean;
  nobitexOrderId: string | null;
  error: string | null;
}

export interface TradeRecord {
  id: number;
  ts: string;
  orderId: number | null;
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  price: number;
  total: number;
  fee: number;
}

export interface WalletBalance {
  currency: string;
  balance: number;
  blockedBalance: number;
  activeBalance: number;
  id: number;
}

export interface PortfolioState {
  equity: number;
  cash: number;
  positionsValue: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  positions: PositionWithValue[];
  marginPositions: MarginPositionWithValue[];
  holdings: Map<string, number>;
}

export interface PositionWithValue extends Position {
  marketValue: number;
  unrealizedPnl: number;
}

export interface MarginPosition {
  id: number;
  symbol: string;
  leverage: number;
  openTs: string;
  entryPrice: number;
  amount: number;
  status: "open" | "closed";
  closeTs: string | null;
  closePrice: number | null;
  realizedPnl: number | null;
  exitReason: string | null;
  orderId: number | null;
}

export interface MarginPositionWithValue extends MarginPosition {
  marketValue: number;
  unrealizedPnl: number;
}
