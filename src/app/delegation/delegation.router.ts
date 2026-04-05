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

// Decrypts RSA-OAEP + AES-256-GCM hybrid encrypted field from Dynamic webhook
const decryptHybrid = (encrypted: {
  ek: string;  // RSA-encrypted AES key (base64)
  iv: string;  // AES-GCM IV (base64)
  ct: string;  // ciphertext (base64)
  tag: string; // GCM auth tag (base64)
}): string => {
  const privateKey = process.env.DYNAMIC_PRIVATE_KEY_PEM!.replace(/\\n/g, "\n");

  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(encrypted.ek, "base64")
  );

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ct, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};

router.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  try {
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

    const { eventName, data } = req.body;

    if (eventName !== "wallet.delegation.created") {
      res.status(200).json({ received: true });
      return;
    }

    console.log("[delegation] decrypting materials for wallet:", data.walletId);

    const decryptedShare = decryptHybrid(data.encryptedDelegatedShare);
    const decryptedApiKey = decryptHybrid(data.encryptedWalletApiKey);

    const publicKey = data.publicKey?.toLowerCase();
    console.log("[delegation] updating user with publicKey:", publicKey);

    const result = await db
      .update(users)
      .set({
        dynamic_wallet_id: data.walletId,
        delegated_share: decryptedShare,
        wallet_api_key: decryptedApiKey,
      })
      .where(eq(users.wallet_address, publicKey));

    console.log("[delegation] stored delegation for wallet:", data.walletId, "rows affected:", result.changes);

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[delegation] webhook error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
