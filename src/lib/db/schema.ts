import { sqliteTable, text, real } from "drizzle-orm/sqlite-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { randomUUID } from "crypto";

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  wallet_address: text("wallet_address").notNull().unique(),
  preset: text("preset"), // 'institutional' | 'degen' | null until onboarding complete
  dynamic_wallet_id: text("dynamic_wallet_id"),
  delegated_share: text("delegated_share"), // AES-256 encrypted ServerKeyShare JSON
  wallet_api_key: text("wallet_api_key"), // AES-256 encrypted wallet API key
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
});

export const proposals = sqliteTable("proposals", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  wallet_address: text("wallet_address")
    .notNull()
    .references(() => users.wallet_address),
  title: text("title").notNull(),
  reasoning: text("reasoning").notNull(),
  token_in: text("token_in").notNull(),
  token_out: text("token_out").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'declined' | 'cancelled'
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const orders = sqliteTable("orders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  proposal_id: text("proposal_id")
    .notNull()
    .references(() => proposals.id),
  type: text("type").notNull(), // 'send' | 'swap' | 'limit_order'
  amount_in: text("amount_in").notNull(),
  expected_out: text("expected_out"),
  to: text("to"), // optional recipient address for 'send' orders
  slippage_tolerance: text("slippage_tolerance"),
  trading_price_usd: real("trading_price_usd"), // null for send/swap; trigger price for limit_order
  confirmation_hash: text("confirmation_hash"),
  status: text("status").notNull().default("pending"), // 'pending' | 'submitted' | 'completed' | 'failed' | 'cancelled'
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

// Users
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

// Proposals
export type Proposal = InferSelectModel<typeof proposals>;
export type NewProposal = InferInsertModel<typeof proposals>;

// Orders
export type Order = InferSelectModel<typeof orders>;
export type NewOrder = InferInsertModel<typeof orders>;
