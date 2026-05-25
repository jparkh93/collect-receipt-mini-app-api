import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { parseJsonBody } from "@/lib/parse-body";

const BUCKET = "documents";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const parsed = await parseJsonBody<{ base64?: string; fileName?: string; mimeType?: string }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { base64, fileName, mimeType } = parsed;

  if (!base64) return NextResponse.json({ error: "이미지 데이터가 없습니다." }, { status: 400 });

  const MAX_BASE64_LENGTH = 20 * 1024 * 1024; // ~15MB decoded
  if (base64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "파일 크기는 15MB 이하여야 합니다." }, { status: 413 });
  }

  const id = randomUUID();
  const mime = mimeType || "image/jpeg";
  const name = fileName || `photo_${Date.now()}.jpg`;
  const safeName = name.replace(/[^\w.\-가-힣]/g, "_").slice(0, 120);
  const storagePath = `${authUser.tenantId}/staged/${id}/${safeName}`;
  const buf = Buffer.from(base64, "base64");

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
      originalName: name,
      mimeType: mime,
      sizeBytes: buf.length,
    },
  });

  return NextResponse.json({ ok: true, stagedId: id });
}
