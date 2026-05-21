import crypto from "crypto";

const TOSS_API_BASE = "https://apps-in-toss-api.toss.im";

export async function exchangeCode(authorizationCode: string, referrer: string) {
  const res = await fetch(
    `${TOSS_API_BASE}/api-partner/v1/apps-in-toss/user/oauth2/generate-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorizationCode, referrer }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Toss token exchange failed: ${err.error || res.status}`);
  }

  const data = await res.json();
  return data.success || data;
}

export async function getUserInfo(accessToken: string) {
  const res = await fetch(
    `${TOSS_API_BASE}/api-partner/v1/apps-in-toss/user/oauth2/login-me`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Toss user info failed: ${err.error || res.status}`);
  }

  const data = await res.json();
  return data.success || data;
}

export function decryptField(encryptedText: string): string {
  const key = Buffer.from(process.env.TOSS_DECRYPT_KEY!, "base64");
  const aad = Buffer.from(process.env.TOSS_DECRYPT_AAD || "TOSS", "utf8");

  const decoded = Buffer.from(encryptedText, "base64");
  const IV_LENGTH = 12;
  const iv = decoded.subarray(0, IV_LENGTH);
  const ciphertext = decoded.subarray(IV_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);

  decipher.setAuthTag(authTag);
  decipher.setAAD(aad);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
