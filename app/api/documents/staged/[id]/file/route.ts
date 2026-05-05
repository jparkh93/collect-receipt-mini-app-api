import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

const BUCKET = "documents";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id: stagedId } = await params;
  const row = await prisma.stagedUpload.findFirst({
    where: { id: stagedId, tenantId: authUser.tenantId },
    select: { storagePath: true, mimeType: true },
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data, error } = await supabase.storage.from(BUCKET).download(row.storagePath);
  if (error || !data) return NextResponse.json({ error: "파일 로드 실패" }, { status: 500 });

  const buf = Buffer.from(await data.arrayBuffer());
  return new Response(buf, {
    headers: {
      "Content-Type": row.mimeType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
