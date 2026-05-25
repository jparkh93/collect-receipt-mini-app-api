import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/toss-auth";
import { exchangeCode, getUserInfo, decryptField } from "@/lib/toss-oauth";
import { parseJsonBody } from "@/lib/parse-body";

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody<{
    authorizationCode?: string;
    referrer?: string;
    identityKey?: string;
    name?: string;
  }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { authorizationCode, referrer, identityKey, name } = parsed;

  let tossIdentityKey: string;
  let userName: string | null = name ?? null;

  if (authorizationCode && referrer) {
    try {
      const tokenData = await exchangeCode(authorizationCode, referrer);
      const userInfo = await getUserInfo(tokenData.accessToken);
      tossIdentityKey = String(userInfo.userKey);

      if (userInfo.name) {
        try {
          userName = decryptField(userInfo.name);
        } catch {
          userName = null;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Toss OAuth failed";
      console.error("[auth/toss] OAuth error:", message);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } else if (identityKey && process.env.NODE_ENV === "development") {
    tossIdentityKey = identityKey;
  } else {
    return NextResponse.json(
      { error: "authorizationCode/referrer 또는 identityKey가 필요합니다." },
      { status: 400 }
    );
  }

  let user = await prisma.user.findFirst({
    where: { tossIdentityKey },
    include: {
      memberships: {
        include: { tenant: { select: { id: true, name: true, businessRegistrationNumber: true } } },
      },
    },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        id: randomUUID(),
        tossIdentityKey,
        name: userName,
      },
      include: {
        memberships: {
          include: { tenant: { select: { id: true, name: true, businessRegistrationNumber: true } } },
        },
      },
    });
  } else if (userName && !user.name) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { name: userName },
      include: {
        memberships: {
          include: { tenant: { select: { id: true, name: true, businessRegistrationNumber: true } } },
        },
      },
    });
  }

  const tenants = user.memberships.map((m: { tenant: { id: string; name: string; businessRegistrationNumber: string | null }; role: string }) => ({
    id: m.tenant.id,
    name: m.tenant.name,
    role: m.role,
    businessRegistrationNumber: m.tenant.businessRegistrationNumber,
  }));

  const defaultTenantId = tenants.length > 0 ? tenants[0].id : null;

  const token = signToken({ userId: user.id, tenantId: defaultTenantId });

  return NextResponse.json({
    token,
    user: { id: user.id, name: user.name },
    tenants,
    needsOnboarding: tenants.length === 0,
  });
}
