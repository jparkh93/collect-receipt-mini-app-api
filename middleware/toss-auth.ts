import { createMiddleware } from "hono/factory";
import jwt from "jsonwebtoken";

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

export const requireAuth = createMiddleware<{
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "인증이 필요합니다." }, 401);
  }
  const token = header.slice(7);
  const user = verifyToken(token);
  if (!user) {
    return c.json({ error: "유효하지 않은 토큰입니다." }, 401);
  }
  c.set("user", user);
  await next();
});
