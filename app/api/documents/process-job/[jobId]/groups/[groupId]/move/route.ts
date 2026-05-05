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
  const { stagedIds, targetGroupId } = await req.json();

  if (!stagedIds || stagedIds.length === 0) {
    return NextResponse.json({ error: "이동할 항목을 선택하세요." }, { status: 400 });
  }

  const srcGroup = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId: authUser.tenantId },
    include: { items: true },
  });
  if (!srcGroup) return NextResponse.json({ error: "원본 그룹을 찾을 수 없습니다." }, { status: 404 });

  let destGroupId: string;
  if (targetGroupId) {
    const dest = await prisma.stagingGroup.findFirst({
      where: { id: targetGroupId, jobId, tenantId: authUser.tenantId },
    });
    if (!dest) return NextResponse.json({ error: "대상 그룹을 찾을 수 없습니다." }, { status: 404 });
    destGroupId = dest.id;
  } else {
    const newGroup = await prisma.stagingGroup.create({
      data: { tenantId: authUser.tenantId, jobId, category: srcGroup.category },
    });
    destGroupId = newGroup.id;
  }

  await prisma.stagedUpload.updateMany({
    where: { id: { in: stagedIds }, groupId },
    data: { groupId: destGroupId },
  });

  const remaining = await prisma.stagedUpload.count({ where: { groupId } });
  if (remaining === 0) {
    await prisma.stagingGroup.delete({ where: { id: groupId } });
  }

  return NextResponse.json({ ok: true, targetGroupId: destGroupId });
}
