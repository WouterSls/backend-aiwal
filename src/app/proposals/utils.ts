import { Proposal } from "../../lib/db/schema";

import { OrderType, ProposalStatus } from "../../lib/types";

export function apiProposalStatusToDb(
  status: Proposal["status"],
): (typeof ProposalStatus)[keyof typeof ProposalStatus] {
  switch (status) {
    case "confirmed":
      return ProposalStatus.Pending;
    case "rejected":
      return ProposalStatus.Declined;
    case "pending":
    default:
      return ProposalStatus.Pending;
  }
}

export type ValidatedTrade = {
  type: OrderType;
  amount_in: string;
  expected_out?: string;
  slippage_tolerance?: string;
  trading_price_usd?: number | null;
};

export function validateTradeDto(
  trade: unknown,
  index: number,
): { ok: true; data: ValidatedTrade } | { ok: false; error: string } {
  if (trade === null || typeof trade !== "object") {
    return { ok: false, error: `trades[${index}] must be an object` };
  }

  const t = trade as Record<string, unknown>;

  const validTypes = Object.values(OrderType) as string[];
  if (typeof t.type !== "string" || !validTypes.includes(t.type)) {
    return {
      ok: false,
      error: `trades[${index}].type must be one of: ${validTypes.join(", ")}`,
    };
  }

  if (typeof t.amount_in !== "string" || t.amount_in.trim() === "") {
    return { ok: false, error: `trades[${index}].amount_in is required` };
  }

  return {
    ok: true,
    data: {
      type: t.type as OrderType,
      amount_in: t.amount_in.trim(),
      expected_out:
        typeof t.expected_out === "string" ? t.expected_out : undefined,
      slippage_tolerance:
        typeof t.slippage_tolerance === "string"
          ? t.slippage_tolerance
          : undefined,
      trading_price_usd:
        typeof t.trading_price_usd === "number" ? t.trading_price_usd : null,
    },
  };
}

export type ValidatedProposalRequest = {
  wallet_address: string;
  title: string;
  reasoning: string;
  token_in: string;
  token_out: string;
  trades: ValidatedTrade[];
};

export function validateProposalRequestDto(
  body: unknown,
): { ok: true; data: ValidatedProposalRequest } | { ok: false; error: string } {
  if (body === null || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const o = body as Record<string, unknown>;

  const wallet_address = o.wallet_address;
  if (typeof wallet_address !== "string" || wallet_address.trim() === "") {
    return { ok: false, error: "wallet_address is required" };
  }

  const title = o.title;
  if (typeof title !== "string" || title.trim() === "") {
    return { ok: false, error: "title is required" };
  }

  const reasoning = o.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim() === "") {
    return { ok: false, error: "reasoning is required" };
  }

  const token_in = o.token_in;
  if (typeof token_in !== "string" || token_in.trim() === "") {
    return { ok: false, error: "token_in is required" };
  }

  const token_out = o.token_out;
  if (typeof token_out !== "string" || token_out.trim() === "") {
    return { ok: false, error: "token_out is required" };
  }

  const rawTrades = o.trades;
  if (!Array.isArray(rawTrades) || rawTrades.length === 0) {
    return { ok: false, error: "trades must be a non-empty array" };
  }

  const trades: ValidatedTrade[] = [];
  for (let i = 0; i < rawTrades.length; i++) {
    const result = validateTradeDto(rawTrades[i], i);
    if (!result.ok) return result;
    trades.push(result.data);
  }

  return {
    ok: true,
    data: {
      wallet_address: wallet_address.trim(),
      title: title.trim(),
      reasoning: reasoning.trim(),
      token_in: token_in.trim(),
      token_out: token_out.trim(),
      trades,
    },
  };
}
