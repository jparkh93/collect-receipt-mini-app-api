import { NextRequest, NextResponse } from "next/server";
import { DocumentType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string; groupId: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { groupId } = await params;
  const { category } = await req.json();

  if (!["expense", "contract", "other"].includes(category)) {
    return NextResponse.json({ error: "유효하지 않은 카테고리입니다." }, { status: 400 });
  }

  const group = await prisma.stagingGroup.findFirst({
    where: { id: groupId, tenantId: authUser.tenantId },
  });
  if (!group) return NextResponse.json({ error: "그룹을 찾을 수 없습니다." }, { status: 404 });

  await prisma.stagingGroup.update({
    where: { id: groupId },
    data: { category: category as DocumentType },
  });

  return NextResponse.json({ ok: true });
}
