import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { prisma } from "@/lib/prisma";

function businessDateYmd(timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());
}

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId)
    return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const tenantId = authUser.tenantId;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (!tenant)
    return NextResponse.json({ error: "테넌트를 찾을 수 없습니다." }, { status: 404 });

  const ymd = businessDateYmd(tenant.timezone);

  const existing = await prisma.dayClose.findUnique({
    where: { tenantId_businessDate: { tenantId, businessDate: ymd } },
  });
  if (!existing)
    return NextResponse.json({ error: "오늘 마감 기록이 없습니다." }, { status: 404 });

  await prisma.dayClose.delete({
    where: { tenantId_businessDate: { tenantId, businessDate: ymd } },
  });

  return NextResponse.json({ ok: true, businessDate: ymd });
}
