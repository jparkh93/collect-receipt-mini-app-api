import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export type AuthUser = {
  userId: string;
  tenantId: string | null;
};

function getJwtSecret(): string {
  const secret = process.env.MINI_APP_JWT_SECRET;
  if (!secret) {
    console.warn("[SECURITY WARNING] MINI_APP_JWT_SECRET is not set. Using fallback. Set this in production!");
    return "dev-secret-change-me";
  }
  return secret;
}

let _jwtSecretCache: string | null = null;
function jwtSecret(): string {
  if (!_jwtSecretCache) _jwtSecretCache = getJwtSecret();
  return _jwtSecretCache;
}

export function signToken(payload: AuthUser): string {
  return jwt.sign(payload, jwtSecret(), { algorithm: "HS256", expiresIn: "7d" });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] }) as AuthUser;
  } catch {
    return null;
  }
}

export function getAuthUser(req: NextRequest): AuthUser | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return verifyToken(header.slice(7));
}

export function unauthorized(message = "인증이 필요합니다.") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function forbidden(message = "접근 권한이 없습니다.") {
  return NextResponse.json({ error: message }, { status: 403 });
}

export async function requireTenantAuth(req: NextRequest): Promise<
  | { user: AuthUser & { tenantId: string }; error?: never }
  | { user?: never; error: NextResponse }
> {
  const authUser = getAuthUser(req);
  if (!authUser) return { error: unauthorized() };
  if (!authUser.tenantId)
    return { error: NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 }) };

  const membership = await prisma.membership.findFirst({
    where: { userId: authUser.userId, tenantId: authUser.tenantId },
  });
  if (!membership) return { error: forbidden() };

  return { user: authUser as AuthUser & { tenantId: string } };
}
