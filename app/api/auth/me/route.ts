import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();

  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    include: {
      memberships: {
        include: { tenant: { select: { id: true, name: true } } },
      },
    },
  });

  if (!user) return unauthorized("유저를 찾을 수 없습니다.");

  const tenants = user.memberships.map((m: { tenant: { id: string; name: string }; role: string }) => ({
    id: m.tenant.id,
    name: m.tenant.name,
    role: m.role,
  }));

  return NextResponse.json({
    user: { id: user.id, name: user.name },
    tenants,
    currentTenantId: authUser.tenantId,
    needsOnboarding: tenants.length === 0,
  });
}
