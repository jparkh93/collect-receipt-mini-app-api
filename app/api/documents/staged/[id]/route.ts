import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

const BUCKET = "documents";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id: stagedId } = await params;
  const row = await prisma.stagedUpload.findFirst({
    where: { id: stagedId, tenantId: authUser.tenantId },
  });
  if (!row) return NextResponse.json({ error: "항목을 찾을 수 없습니다." }, { status: 404 });

  await supabase.storage.from(BUCKET).remove([row.storagePath]);
  await prisma.stagedUpload.delete({ where: { id: stagedId } });

  return NextResponse.json({ ok: true });
}
