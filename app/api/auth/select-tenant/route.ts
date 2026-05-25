import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, signToken, unauthorized } from "@/lib/toss-auth";
import { parseJsonBody } from "@/lib/parse-body";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();

  const parsed = await parseJsonBody<{ tenantId?: string }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { tenantId } = parsed;

  const membership = await prisma.membership.findFirst({
    where: { userId: authUser.userId, tenantId },
  });
  if (!membership) {
    return NextResponse.json({ error: "해당 매장에 대한 접근 권한이 없습니다." }, { status: 403 });
  }

  const token = signToken({ userId: authUser.userId, tenantId: tenantId ?? null });
  return NextResponse.json({ token });
}
