import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const entry = await prisma.journalEntry.findFirst({
    where: { id, tenantId: authUser.tenantId, status: "draft" },
  });
  if (!entry) return NextResponse.json({ error: "대기 상태인 지출을 찾을 수 없습니다." }, { status: 404 });

  if (entry.amountMinor <= 0) {
    return NextResponse.json({ error: "금액이 0원입니다. 금액을 확인해 주세요." }, { status: 400 });
  }

  await prisma.journalEntry.update({
    where: { id },
    data: {
      status: "posted",
      postedAt: new Date(),
      approvedById: authUser.userId,
    },
  });

  return NextResponse.json({ ok: true });
}
