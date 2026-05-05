import jwt from "jsonwebtoken";
import { NextRequest, NextResponse } from "next/server";

export type AuthUser = {
  userId: string;
  tenantId: string | null;
};

const JWT_SECRET = process.env.MINI_APP_JWT_SECRET ?? "dev-secret-change-me";

export function signToken(payload: AuthUser): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser;
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
