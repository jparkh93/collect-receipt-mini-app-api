import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId)
    return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const tenantId = authUser.tenantId;

  const doc = await prisma.document.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  if (doc.type !== "expense") {
    return NextResponse.json(
      { error: "지출 문서만 지출 등록이 가능합니다." },
      { status: 400 },
    );
  }

  const existing = await prisma.journalEntry.findFirst({
    where: { tenantId, documentId: id },
  });
  if (existing) {
    return NextResponse.json(
      { error: "이 문서에 연결된 지출 내역이 이미 있습니다." },
      { status: 400 },
    );
  }

  const amountMinor = doc.amountMinor ?? 0;
  const paymentMethod = doc.paymentMethod ?? null;
  const shouldPost = amountMinor > 0 && paymentMethod !== null;

  const entry = await prisma.journalEntry.create({
    data: {
      tenantId,
      documentId: id,
      description: doc.title ?? "지출",
      amountMinor,
      paymentMethod,
      status: shouldPost ? "posted" : "draft",
      postedAt: shouldPost ? new Date() : undefined,
    },
  });

  await prisma.document.update({
    where: { id },
    data: { status: "linked" },
  });

  return NextResponse.json({ entryId: entry.id, posted: shouldPost });
}
