import { Router, Request, Response } from "express";
import crypto from "crypto";
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
  if (trusted.length !== untrusted.length) return false;
  return crypto.timingSafeEqual(trusted, untrusted);
};

router.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  try {
  console.log("[delegation] webhook received headers:", req.headers);
  console.log("[delegation] webhook body:", JSON.stringify(req.body, null, 2));

  const signature = req.headers["x-dynamic-signature-256"] as string;

  if (!signature) {
    console.log("[delegation] missing signature header");
    res.status(401).json({ error: "Missing signature" });
    return;
  }

  const isValid = verifySignature({
    secret: process.env.DYNAMIC_WEBHOOK_SECRET!,
    signature,
    payload: req.body,
  });

  console.log("[delegation] signature valid:", isValid);

  if (!isValid) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const { eventName, data } = req.body;

  if (eventName !== "wallet.delegation.created") {
    res.status(200).json({ received: true });
    return;
  }

  // TODO: decrypt data.encryptedDelegatedShare and data.encryptedWalletApiKey
  // once decryption is confirmed working, store on user row
  console.log("[delegation] delegation event data:", JSON.stringify(data, null, 2));

  res.status(200).json({ received: true });
  } catch (err) {
    console.error("[delegation] webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
