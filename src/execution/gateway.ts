import { SymbolPair } from "../types.js";

export type OrderStatus = "new" | "filled" | "canceled" | "failed";

export interface PollResult {
  status: OrderStatus;
  fillPrice?: number;
  filledAmount?: number;
}

export interface MarketResult {
  price: number;
  amount: number;
}

export interface OrderGateway {
  getBestPrices(pair: SymbolPair): { ask: number | null; bid: number | null };
  getLatestPrice(pair: SymbolPair): number | null;
  getBalance(currency: string): number;
  placeLimit(pair: SymbolPair, side: "buy" | "sell", amount: number, price: number, kind: string): Promise<number | null>;
  cancel(orderId: number): Promise<boolean>;
  poll(orderId: number): Promise<PollResult>;
  market(pair: SymbolPair, side: "buy" | "sell", amount: number, kind: string): Promise<MarketResult | null>;
}
