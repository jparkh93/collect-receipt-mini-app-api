import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

const BUCKET = "documents";

function buildSearchText(parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join("\n").slice(0, 20000) || null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const doc = await prisma.document.findFirst({
    where: { id, tenantId: authUser.tenantId, deletedAt: null },
    include: {
      pages: { orderBy: { ordinal: "asc" } },
      journalEntry: { select: { id: true, status: true } },
    },
  });
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  return NextResponse.json({ document: doc });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const body = await req.json();

  const doc = await prisma.document.findFirst({
    where: { id, tenantId: authUser.tenantId, deletedAt: null },
  });
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const title = body.title !== undefined ? body.title : doc.title;
  const summary = body.summary !== undefined ? body.summary : doc.summary;
  const vendorName = body.vendorName !== undefined ? body.vendorName : doc.vendorName;
  const amountMinor = body.amountMinor !== undefined ? body.amountMinor : doc.amountMinor;
  const ocrRawText = body.ocrRawText !== undefined ? body.ocrRawText : doc.ocrRawText;

  const searchText = buildSearchText([title, summary, ocrRawText, vendorName]);

  const updated = await prisma.document.update({
    where: { id },
    data: {
      ...(body.title !== undefined && { title }),
      ...(body.summary !== undefined && { summary }),
      ...(body.vendorName !== undefined && { vendorName }),
      ...(body.amountMinor !== undefined && { amountMinor }),
      ...(body.ocrRawText !== undefined && { ocrRawText }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.paymentMethod !== undefined && { paymentMethod: body.paymentMethod }),
      searchText,
    },
  });

  return NextResponse.json({ document: updated });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const tenantId = authUser.tenantId;

  const doc = await prisma.document.findFirst({
    where: { id, tenantId, deletedAt: null },
    include: {
      journalEntry: { select: { id: true, status: true } },
      pages: { select: { storagePath: true } },
    },
  });
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  if (doc.journalEntry?.status === "posted") {
    return NextResponse.json(
      { error: "승인된 지출 내역이 연결되어 있어 문서를 삭제할 수 없습니다." },
      { status: 400 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.journalEntry.deleteMany({
      where: { tenantId, documentId: id, status: "draft" },
    });
    await tx.documentPage.deleteMany({
      where: { documentId: id },
    });
    await tx.document.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  });

  const pathsToRemove = [
    ...new Set([doc.storagePath, ...doc.pages.map((p) => p.storagePath)]),
  ];
  const { error: removeErr } = await supabase.storage
    .from(BUCKET)
    .remove(pathsToRemove);
  if (removeErr) {
    console.warn("[deleteDocument] storage remove:", removeErr.message);
  }

  return NextResponse.json({ ok: true });
}
