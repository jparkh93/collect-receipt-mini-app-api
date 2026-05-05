import { Hono } from "hono";
import { requireAuth } from "../middleware/toss-auth";
import { signToken } from "../middleware/toss-auth";
import { prisma } from "../lib/prisma";
import type { AppEnv } from "../types";

export const onboardingRoutes = new Hono<AppEnv>();

onboardingRoutes.use("*", requireAuth);

onboardingRoutes.post("/create-tenant", async (c) => {
  const { userId } = c.get("user");

  const body = await c.req.json<{ name?: string; businessRegistrationNumber?: string }>();
  const name = (body.name ?? "").trim();
  const brnRaw = (body.businessRegistrationNumber ?? "").trim();

  if (!name) {
    return c.json({ error: "매장 이름을 입력하세요." }, 400);
  }

  const digits = brnRaw.replace(/[^0-9]/g, "");
  if (digits.length !== 10) {
    return c.json(
      { error: "사업자등록번호는 숫자 10자리로 입력하세요." },
      400,
    );
  }
  const businessRegistrationNumber = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;

  const existing = await prisma.tenant.findFirst({
    where: { businessRegistrationNumber },
    select: { id: true, name: true },
  });
  if (existing) {
    return c.json(
      { error: `이미 등록된 사업자등록번호입니다. (${existing.name})` },
      409,
    );
  }

  const tenant = await prisma.tenant.create({
    data: {
      name,
      businessRegistrationNumber,
    },
  });

  await prisma.membership.create({
    data: {
      tenantId: tenant.id,
      userId,
      role: "owner",
    },
  });

  const token = signToken({ userId, tenantId: tenant.id });

  return c.json({
    ok: true,
    token,
    tenant: { id: tenant.id, name: tenant.name },
  });
});
