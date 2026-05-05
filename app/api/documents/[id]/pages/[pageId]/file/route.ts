import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

const BUCKET = "documents";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pageId: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id, pageId } = await params;

  const doc = await prisma.document.findFirst({
    where: { id, tenantId: authUser.tenantId },
    select: { id: true },
  });
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const page = await prisma.documentPage.findFirst({
    where: { id: pageId, documentId: id },
    select: { storagePath: true, mimeType: true },
  });
  if (!page) return NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 });

  const { data, error } = await supabase.storage.from(BUCKET).download(page.storagePath);
  if (error || !data) return NextResponse.json({ error: "파일 로드 실패" }, { status: 500 });

  const buf = Buffer.from(await data.arrayBuffer());
  return new Response(buf, {
    headers: {
      "Content-Type": page.mimeType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
