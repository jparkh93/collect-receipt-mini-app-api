import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const status = req.nextUrl.searchParams.get("status");
  const where: Record<string, unknown> = { tenantId: authUser.tenantId };
  if (status === "draft" || status === "posted") {
    where.status = status;
  }

  const entries = await prisma.journalEntry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      description: true,
      amountMinor: true,
      status: true,
      paymentMethod: true,
      createdAt: true,
      document: { select: { businessDate: true } },
    },
  });

  return NextResponse.json({
    entries: entries.map((e) => ({
      id: e.id,
      description: e.description,
      amount: e.amountMinor,
      status: e.status,
      paymentMethod: e.paymentMethod,
      createdAt: e.createdAt,
      businessDate: e.document?.businessDate ?? null,
    })),
  });
}

const VALID_PAYMENT_METHODS = new Set(["cash", "card", "transfer"]);

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const body = await req.json();
  const { description, amountMinor, paymentMethod } = body as {
    description?: string;
    amountMinor?: number;
    paymentMethod?: string | null;
  };

  if (!description || !description.trim()) {
    return NextResponse.json({ error: "내용을 입력해 주세요." }, { status: 400 });
  }

  const amount = Math.round(Number(amountMinor));
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "금액은 0보다 커야 합니다." }, { status: 400 });
  }

  const pm = paymentMethod && VALID_PAYMENT_METHODS.has(paymentMethod) ? paymentMethod : null;

  const entry = await prisma.journalEntry.create({
    data: {
      tenantId: authUser.tenantId,
      description: description.trim(),
      amountMinor: amount,
      paymentMethod: pm,
      status: "draft",
    },
  });

  return NextResponse.json({ entry }, { status: 201 });
}
