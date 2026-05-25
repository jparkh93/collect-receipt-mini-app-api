import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

const BUCKET = "documents";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file || file.size === 0) {
    return NextResponse.json({ error: "파일을 선택하세요." }, { status: 400 });
  }

  const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "파일 크기는 15MB 이하여야 합니다." }, { status: 413 });
  }

  const id = randomUUID();
  const safeName = file.name.replace(/[^\w.\-가-힣]/g, "_").slice(0, 120);
  const storagePath = `${authUser.tenantId}/staged/${id}/${safeName}`;
  const mime = file.type || "application/octet-stream";
  const buf = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType: mime, upsert: false });

  if (upErr) {
    return NextResponse.json({ error: `업로드 실패: ${upErr.message}` }, { status: 500 });
  }

  await prisma.stagedUpload.create({
    data: {
      id,
      tenantId: authUser.tenantId,
      uploadedById: authUser.userId,
      storagePath,
      originalName: file.name,
      mimeType: mime,
      sizeBytes: buf.length,
    },
  });

  return NextResponse.json({ ok: true, stagedId: id });
}
