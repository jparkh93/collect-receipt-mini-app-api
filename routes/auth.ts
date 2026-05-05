import { Hono } from "hono";
import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { signToken } from "../middleware/toss-auth";

export const authRoutes = new Hono();

/**
 * POST /api/auth/toss
 * 토스 유저 식별키로 로그인/회원가입
 */
authRoutes.post("/toss", async (c) => {
  const { identityKey, name } = await c.req.json<{
    identityKey: string;
    name?: string;
  }>();

  if (!identityKey) {
    return c.json({ error: "identityKey가 필요합니다." }, 400);
  }

  let user = await prisma.user.findFirst({
    where: { tossIdentityKey: identityKey },
    include: {
      memberships: {
        include: { tenant: { select: { id: true, name: true } } },
      },
    },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        id: randomUUID(),
        tossIdentityKey: identityKey,
        name: name ?? null,
      },
      include: {
        memberships: {
          include: { tenant: { select: { id: true, name: true } } },
        },
      },
    });
  }

  const tenants = user.memberships.map((m: { tenant: { id: string; name: string }; role: string }) => ({
    id: m.tenant.id,
    name: m.tenant.name,
    role: m.role,
  }));

  const defaultTenantId = tenants.length > 0 ? tenants[0].id : null;

  const token = signToken({
    userId: user.id,
    tenantId: defaultTenantId,
  });

  return c.json({
    token,
    user: { id: user.id, name: user.name },
    tenants,
    needsOnboarding: tenants.length === 0,
  });
});

/**
 * GET /api/auth/me
 * 현재 세션 검증 + 유저 정보 반환
 */
authRoutes.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "인증이 필요합니다." }, 401);
  }

  const { verifyToken } = await import("../middleware/toss-auth");
  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return c.json({ error: "유효하지 않은 토큰입니다." }, 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: {
      memberships: {
        include: { tenant: { select: { id: true, name: true } } },
      },
    },
  });
  if (!user) {
    return c.json({ error: "유저를 찾을 수 없습니다." }, 401);
  }

  const tenants = user.memberships.map((m: { tenant: { id: string; name: string }; role: string }) => ({
    id: m.tenant.id,
    name: m.tenant.name,
    role: m.role,
  }));

  return c.json({
    user: { id: user.id, name: user.name },
    tenants,
    currentTenantId: payload.tenantId,
    needsOnboarding: tenants.length === 0,
  });
});

/**
 * POST /api/auth/select-tenant
 * 테넌트 전환
 */
authRoutes.post("/select-tenant", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "인증이 필요합니다." }, 401);
  }

  const { verifyToken } = await import("../middleware/toss-auth");
  const current = verifyToken(authHeader.slice(7));
  if (!current) {
    return c.json({ error: "유효하지 않은 토큰입니다." }, 401);
  }

  const { tenantId } = await c.req.json<{ tenantId: string }>();

  const membership = await prisma.membership.findFirst({
    where: { userId: current.userId, tenantId },
  });
  if (!membership) {
    return c.json({ error: "해당 매장에 대한 접근 권한이 없습니다." }, 403);
  }

  const token = signToken({
    userId: current.userId,
    tenantId,
  });

  return c.json({ token });
});
