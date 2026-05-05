import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const entry = await prisma.journalEntry.findFirst({
    where: { id, tenantId: authUser.tenantId },
    include: { document: { select: { id: true, title: true } } },
  });
  if (!entry) return NextResponse.json({ error: "지출을 찾을 수 없습니다." }, { status: 404 });

  return NextResponse.json({ entry });
}

const VALID_PAYMENT_METHODS = new Set(["cash", "card", "transfer"]);

export async function PATCH(req: NextRequest, { params }: RouteCtx) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const entry = await prisma.journalEntry.findFirst({
    where: { id, tenantId: authUser.tenantId },
  });
  if (!entry) return NextResponse.json({ error: "지출을 찾을 수 없습니다." }, { status: 404 });

  if (entry.status !== "draft") {
    return NextResponse.json({ error: "승인된 지출 내역은 수정할 수 없습니다." }, { status: 400 });
  }

  const body = await req.json();
  const { amountMinor, paymentMethod, description } = body as {
    amountMinor?: number;
    paymentMethod?: string | null;
    description?: string;
  };

  const update: Record<string, unknown> = {};

  if (description !== undefined) {
    update.description = description?.trim() || entry.description;
  }

  if (amountMinor !== undefined) {
    const amount = Math.round(Number(amountMinor));
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "금액은 0 이상이어야 합니다." }, { status: 400 });
    }
    update.amountMinor = amount;
  }

  if (paymentMethod !== undefined) {
    if (paymentMethod !== null && !VALID_PAYMENT_METHODS.has(paymentMethod)) {
      return NextResponse.json({ error: "결제 수단이 올바르지 않습니다." }, { status: 400 });
    }
    update.paymentMethod = paymentMethod;
  }

  const updated = await prisma.journalEntry.update({
    where: { id },
    data: update,
  });

  return NextResponse.json({ entry: updated });
}

export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const entry = await prisma.journalEntry.findFirst({
    where: { id, tenantId: authUser.tenantId },
  });
  if (!entry) return NextResponse.json({ error: "지출을 찾을 수 없습니다." }, { status: 404 });

  if (entry.status !== "draft") {
    return NextResponse.json(
      { error: "검토 대기인 지출 내역만 삭제할 수 있습니다. 승인된 건은 삭제할 수 없습니다." },
      { status: 400 },
    );
  }

  const documentId = entry.documentId;

  await prisma.journalEntry.delete({ where: { id } });

  if (documentId) {
    await prisma.document.updateMany({
      where: { id: documentId, tenantId: authUser.tenantId, deletedAt: null },
      data: { status: "needs_review" },
    });
  }

  return NextResponse.json({ ok: true });
}
