import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAuth } from "@/lib/toss-auth";
import { parseJsonBody } from "@/lib/parse-body";

export async function GET(req: NextRequest) {
  const auth = await requireTenantAuth(req);
  if (auth.error) return auth.error;
  const authUser = auth.user;

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
  const auth = await requireTenantAuth(req);
  if (auth.error) return auth.error;
  const authUser = auth.user;

  const parsed = await parseJsonBody<{
    description?: string;
    amountMinor?: number;
    paymentMethod?: string | null;
  }>(req);
  if (parsed instanceof NextResponse) return parsed;
  const { description, amountMinor, paymentMethod } = parsed;

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
