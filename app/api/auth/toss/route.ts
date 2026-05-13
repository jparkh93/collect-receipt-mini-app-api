import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/toss-auth";

export async function POST(req: NextRequest) {
  const { identityKey, name } = await req.json();

  if (!identityKey) {
    return NextResponse.json({ error: "identityKey가 필요합니다." }, { status: 400 });
  }

  let user = await prisma.user.findFirst({
    where: { tossIdentityKey: identityKey },
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
        tossIdentityKey: identityKey,
        name: name ?? null,
      },
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
