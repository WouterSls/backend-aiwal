import { Router, Request, Response } from "express";
import crypto from "crypto";
import { decryptDelegatedWebhookData } from "@dynamic-labs-wallet/node";
import { db } from "../../lib/db/db";
import { users } from "../../lib/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

const verifySignature = ({
  secret,
  signature,
  payload,
}: {
  secret: string;
  signature: string;
  payload: any;
}) => {
  const payloadSignature = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
  const trusted = Buffer.from(`sha256=${payloadSignature}`, "ascii");
  const untrusted = Buffer.from(signature, "ascii");
  return crypto.timingSafeEqual(trusted, untrusted);
};

router.post("/webhook", async (req: Request, res: Response) => {
  const signature = req.headers["x-dynamic-signature-256"] as string;

  if (!signature) {
    res.status(401).json({ error: "Missing signature" });
    return;
  }

  const isValid = verifySignature({
    secret: process.env.DYNAMIC_WEBHOOK_SECRET!,
    signature,
    payload: req.body,
  });

  if (!isValid) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { eventName, userId, data } = req.body;

  if (eventName !== "wallet.delegation.created") {
    res.status(200).json({ received: true });
    return;
  }

  const { decryptedDelegatedShare, decryptedWalletApiKey } =
    decryptDelegatedWebhookData({
      privateKeyPem: process.env.DYNAMIC_PRIVATE_KEY_PEM!,
      encryptedDelegatedKeyShare: data.encryptedDelegatedShare,
      encryptedWalletApiKey: data.encryptedWalletApiKey,
    });

  await db
    .update(users)
    .set({
      delegated_share: decryptedDelegatedShare,
      wallet_api_key: decryptedWalletApiKey,
    })
    .where(eq(users.dynamic_wallet_id, data.walletId));

  res.status(200).json({ received: true });
});

export default router;
