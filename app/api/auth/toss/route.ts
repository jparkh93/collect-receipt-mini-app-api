import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/toss-auth";
import { exchangeCode, getUserInfo, decryptField } from "@/lib/toss-oauth";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { authorizationCode, referrer, identityKey, name } = body;

  let tossIdentityKey: string;
  let userName: string | null = name ?? null;

  if (authorizationCode && referrer) {
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
  } else if (identityKey) {
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
