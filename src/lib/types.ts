export enum OrderType {
  Send = "send",
  Swap = "swap",
  LimitOrder = "limit_order",
}

export enum ProposalStatus {
  Pending = "pending",
  Declined = "declined",
  Cancelled = "cancelled",
}

export enum OrderStatus {
  Pending = "pending",
  Submitted = "submitted",
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export interface Trade {
  type: OrderType;
  amount_in: string;
  expected_out?: string;
  to?: string;
  slippage_tolerance?: string;
  trading_price_usd?: number;
}

export interface TradingStrategy {
  title: string;
  reasoning: string;
  token_in: string;
  token_out: string;
  trades: Trade[];
}
