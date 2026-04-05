import { Router } from "express";
import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import {
  NewOrder,
  NewProposal,
  Order,
  orders,
  proposals,
} from "../../lib/db/schema";
import { validateProposalRequestDto } from "./utils";
import { db } from "../../lib/db/db";
import { OrderStatus, ProposalStatus } from "../../lib/types";
import { Scanner } from "../../lib/scanner";

const router = Router();

interface ProposalDto {
  id: string;
  wallet_address: string;
  title: string;
  reasoning: string;
  token_in: string;
  token_out: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  orders: Order[];
}

router.get("/", (req, res) => {
  const { walletAddress } = req.query;
  if (!walletAddress) {
    res.status(200).json({ proposals: [] });
    return;
  }

  const foundProposals = db
    .select()
    .from(proposals)
    .where(eq(proposals.wallet_address, (walletAddress as string).toLowerCase()))
    .all();

  if (foundProposals.length === 0) {
    res.status(200).json({ proposals: [] });
    return;
  }

  const proposalIds = foundProposals.map((p) => p.id);

  const foundOrders = db
    .select()
    .from(orders)
    .where(inArray(orders.proposal_id, proposalIds))
    .all();

  const result: ProposalDto[] = foundProposals.map((proposal) => ({
    ...proposal,
    orders: foundOrders.filter((o) => o.proposal_id === proposal.id),
  }));

  res.status(200).json({ proposals: result });
});

router.post("/", async (req, res) => {
  const validation = validateProposalRequestDto(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const { wallet_address, title, reasoning, token_in, token_out, trades } =
    validation.data;

  const proposalId = randomUUID();

  const newProposal: NewProposal = {
    id: proposalId,
    wallet_address: wallet_address.toLowerCase(),
    title,
    reasoning,
    token_in,
    token_out,
    status: ProposalStatus.Pending,
    created_at: new Date().toISOString(),
  };

  db.insert(proposals).values(newProposal).run();

  const newOrders: NewOrder[] = trades.map((trade) => ({
    id: randomUUID(),
    proposal_id: proposalId,
    type: trade.type,
    amount_in: trade.amount_in,
    expected_out: trade.expected_out ?? null,
    slippage_tolerance: trade.slippage_tolerance ?? null,
    trading_price_usd: trade.trading_price_usd ?? null,
    status: OrderStatus.Pending,
    created_at: new Date().toISOString(),
  }));

  db.insert(orders).values(newOrders).run();
  Scanner.getInstance().notify();

  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    res.status(500).json({ message: "Internal Server Error" });
    return;
  }

  const confirmUrl = `${frontendUrl}/api/proposal/confirmation?wallet_address=${wallet_address}`;

  try {
    const response = await fetch(confirmUrl, {
      method: "POST",
    });

    if (!response.ok) {
      console.log(`error sending confirmation`);
      throw new Error("Error Proposal Confirmation Frontend");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      error: "Failed to reach frontend confirmation endpoint",
      detail: message,
    });
  }
});

export default router;
