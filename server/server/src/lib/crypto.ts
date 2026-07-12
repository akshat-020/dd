import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Field-level encryption at rest for price/cost data (OrderLinePrice,
// InvoiceReferenceLine, PurchaseCostReference) — defense in depth beyond
// role-based access control, so a raw database file or backup copy doesn't
// expose pricing/cost even to someone who bypasses the API entirely.
// AES-256-GCM: authenticated encryption, so tampering with a stored value
// is detected on decrypt rather than silently producing garbage.

function getKey(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("FIELD_ENCRYPTION_KEY environment variable is required");
  }
  const key = raw.includes("/") || raw.includes("+") || raw.length % 4 === 0 ? Buffer.from(raw, "base64") : Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex)");
  }
  return key;
}

// Stored format: base64(iv) + "." + base64(authTag) + "." + base64(ciphertext)
export function encryptField(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptField(stored: string): string {
  const key = getKey();
  const [ivB64, tagB64, ctB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted field value");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

export function encryptNumber(value: number): string {
  return encryptField(String(value));
}

export function decryptNumber(stored: string): number {
  return Number(decryptField(stored));
}
