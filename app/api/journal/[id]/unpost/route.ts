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
    where: { id, tenantId: authUser.tenantId, status: "posted" },
  });
  if (!entry) return NextResponse.json({ error: "승인된 지출을 찾을 수 없습니다." }, { status: 404 });

  await prisma.journalEntry.update({
    where: { id },
    data: {
      status: "draft",
      postedAt: null,
      approvedById: null,
    },
  });

  return NextResponse.json({ ok: true });
}
