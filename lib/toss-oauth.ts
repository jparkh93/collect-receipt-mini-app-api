import crypto from "crypto";
import { Agent, fetch as undiciFetch } from "undici";

const TOSS_API_BASE = "https://apps-in-toss-api.toss.im";

function getTossAgent(): Agent {
  const cert = process.env.TOSS_MTLS_CERT;
  const key = process.env.TOSS_MTLS_KEY;

  if (!cert || !key) {
    throw new Error("TOSS_MTLS_CERT and TOSS_MTLS_KEY env vars are required");
  }

  return new Agent({
    connect: {
      cert: Buffer.from(cert, "base64").toString(),
      key: Buffer.from(key, "base64").toString(),
    },
  });
}

async function tossFetch(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const agent = getTossAgent();
  try {
    const res = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      dispatcher: agent,
    });
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json() as Promise<unknown>,
    };
  } finally {
    await agent.close();
  }
}

interface TossTokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

export async function exchangeCode(authorizationCode: string, referrer: string): Promise<TossTokenResponse> {
  const res = await tossFetch(
    `${TOSS_API_BASE}/api-partner/v1/apps-in-toss/user/oauth2/generate-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorizationCode, referrer }),
    }
  );

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`Toss token exchange failed: ${err.error || res.status}`);
  }

  const data = (await res.json()) as { success?: TossTokenResponse } & TossTokenResponse;
  return data.success || data;
}

interface TossUserInfo {
  userKey: string | number;
  name?: string;
}

export async function getUserInfo(accessToken: string): Promise<TossUserInfo> {
  const res = await tossFetch(
    `${TOSS_API_BASE}/api-partner/v1/apps-in-toss/user/oauth2/login-me`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`Toss user info failed: ${err.error || res.status}`);
  }

  const data = (await res.json()) as { success?: TossUserInfo } & TossUserInfo;
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
