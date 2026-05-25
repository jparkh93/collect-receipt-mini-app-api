import crypto from "crypto";
import https from "https";

const TOSS_API_BASE = "https://apps-in-toss-api.toss.im";

function decodePem(envValue: string): string {
  if (envValue.startsWith("-----")) {
    return envValue.replace(/\\n/g, "\n");
  }
  return Buffer.from(envValue, "base64").toString("utf8");
}

function getMtlsAgent(): https.Agent {
  const cert = process.env.TOSS_MTLS_CERT;
  const key = process.env.TOSS_MTLS_KEY;

  if (!cert || !key) {
    throw new Error("TOSS_MTLS_CERT and TOSS_MTLS_KEY env vars are required");
  }

  return new https.Agent({
    cert: decodePem(cert),
    key: decodePem(key),
    rejectUnauthorized: true,
  });
}

const REQUEST_TIMEOUT_MS = 10_000;

function httpsRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string }
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const agent = getMtlsAgent();

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: options.headers,
        agent,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ statusCode: res.statusCode || 500, body });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Toss API request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => reject(err));

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

interface TossTokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

export async function exchangeCode(authorizationCode: string, referrer: string): Promise<TossTokenResponse> {
  const { statusCode, body } = await httpsRequest(
    `${TOSS_API_BASE}/api-partner/v1/apps-in-toss/user/oauth2/generate-token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorizationCode, referrer }),
    }
  );

  const data = JSON.parse(body) as { success?: TossTokenResponse; error?: string } & TossTokenResponse;

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Toss token exchange failed (${statusCode}): ${data.error || body}`);
  }

  return data.success || data;
}

interface TossUserInfo {
  userKey: string | number;
  name?: string;
}

export async function getUserInfo(accessToken: string): Promise<TossUserInfo> {
  const { statusCode, body } = await httpsRequest(
    `${TOSS_API_BASE}/api-partner/v1/apps-in-toss/user/oauth2/login-me`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const data = JSON.parse(body) as { success?: TossUserInfo; error?: string } & TossUserInfo;

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Toss user info failed (${statusCode}): ${data.error || body}`);
  }

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
