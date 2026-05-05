import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const entry = await prisma.journalEntry.findFirst({
    where: { id, tenantId: authUser.tenantId },
    include: { document: { select: { id: true, title: true } } },
  });
  if (!entry) return NextResponse.json({ error: "지출을 찾을 수 없습니다." }, { status: 404 });

  return NextResponse.json({ entry });
}

export async function PATCH() {
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  return NextResponse.json({ ok: true });
}
