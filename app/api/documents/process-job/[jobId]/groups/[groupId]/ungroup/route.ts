import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string; groupId: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { jobId, groupId } = await params;

  const group = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId: authUser.tenantId },
    include: { items: true },
  });
  if (!group) return NextResponse.json({ error: "그룹을 찾을 수 없습니다." }, { status: 404 });
  if (group.items.length <= 1) {
    return NextResponse.json({ error: "1개 항목은 해체할 수 없습니다." }, { status: 400 });
  }

  for (const item of group.items) {
    const newGroup = await prisma.stagingGroup.create({
      data: { tenantId: authUser.tenantId, jobId, category: group.category },
    });
    await prisma.stagedUpload.update({
      where: { id: item.id },
      data: { groupId: newGroup.id },
    });
  }

  await prisma.stagingGroup.delete({ where: { id: groupId } });

  return NextResponse.json({ ok: true });
}
