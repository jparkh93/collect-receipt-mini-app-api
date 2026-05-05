import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

const BUCKET = "documents";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string; groupId: string; stagedId: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { jobId, groupId, stagedId } = await params;

  const group = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId: authUser.tenantId },
  });
  if (!group) return NextResponse.json({ error: "그룹을 찾을 수 없습니다." }, { status: 404 });

  const item = await prisma.stagedUpload.findFirst({ where: { id: stagedId, groupId } });
  if (!item) return NextResponse.json({ error: "항목을 찾을 수 없습니다." }, { status: 404 });

  await supabase.storage.from(BUCKET).remove([item.storagePath]);
  await prisma.stagedUpload.delete({ where: { id: stagedId } });

  const remaining = await prisma.stagedUpload.count({ where: { groupId } });
  if (remaining === 0) {
    await prisma.stagingGroup.delete({ where: { id: groupId } });
  }

  return NextResponse.json({ ok: true });
}
