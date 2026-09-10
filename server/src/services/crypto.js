import crypto from "node:crypto";

// ENCRYPTION_KEY is the one credential that MUST stay a Railway/host env
// var — it's the key that unlocks every other credential stored in the
// Setting table, so it can't itself live in that table (nothing to
// bootstrap it with). Any string works: it's hashed to a fixed 32 bytes,
// so there's no length requirement to get right.
function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "ENCRYPTION_KEY is not set — required to store/read credentials from Admin Settings. Set it as a host env var (any random string)."
    );
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(payload) {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
