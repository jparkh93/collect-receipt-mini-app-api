import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, signToken, unauthorized } from "@/lib/toss-auth";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();

  const { tenantId } = await req.json();

  const membership = await prisma.membership.findFirst({
    where: { userId: authUser.userId, tenantId },
  });
  if (!membership) {
    return NextResponse.json({ error: "해당 매장에 대한 접근 권한이 없습니다." }, { status: 403 });
  }

  const token = signToken({ userId: authUser.userId, tenantId });
  return NextResponse.json({ token });
}
