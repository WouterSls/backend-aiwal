import { Router } from "express";
import { db } from "../../lib/db/db";
import { users } from "../../lib/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/", (req, res) => {
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return res
      .status(400)
      .json({ error: "walletAddress query param is required" });
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.wallet_address, walletAddress))
    .limit(1)
    .get();

  return user
    ? res.status(200).json(user)
    : res.status(404).json({ error: "User not found" });
});

router.post("/", (req, res) => {
  const { walletAddress, preset } = req.body as {
    walletAddress: string;
    preset?: string;
  };

  if (!walletAddress) {
    return res
      .status(400)
      .json({ error: "dynamic_id and wallet_address are required" });
  }

  const user = db
    .insert(users)
    .values({ wallet_address: walletAddress, preset })
    .returning()
    .get();

  res.status(201).json(user);
});

export default router;
