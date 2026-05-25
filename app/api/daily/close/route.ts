import { NextRequest, NextResponse } from "next/server";
import { requireTenantAuth } from "@/lib/toss-auth";
import { prisma } from "@/lib/prisma";

function businessDateYmd(timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());
}

export async function POST(req: NextRequest) {
  const auth = await requireTenantAuth(req);
  if (auth.error) return auth.error;
  const authUser = auth.user;

  const tenantId = authUser.tenantId;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });

  const { cashMinor, cardMinor, otherMinor, memo } = body as {
    cashMinor?: number;
    cardMinor?: number;
    otherMinor?: number;
    memo?: string;
  };

  if (
    typeof cashMinor !== "number" || cashMinor < 0 ||
    typeof cardMinor !== "number" || cardMinor < 0 ||
    typeof otherMinor !== "number" || otherMinor < 0
  ) {
    return NextResponse.json(
      { error: "매출 금액은 0 이상의 숫자여야 합니다." },
      { status: 400 },
    );
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (!tenant)
    return NextResponse.json({ error: "테넌트를 찾을 수 없습니다." }, { status: 404 });

  const ymd = businessDateYmd(tenant.timezone);

  const existing = await prisma.dayClose.findUnique({
    where: { tenantId_businessDate: { tenantId, businessDate: ymd } },
  });
  if (existing)
    return NextResponse.json({ error: "이미 마감된 영업일입니다." }, { status: 409 });

  const previousClose = await prisma.dayClose.findFirst({
    where: { tenantId, businessDate: { lt: ymd } },
    orderBy: { businessDate: "desc" },
    select: { closedAt: true },
  });

  const start = previousClose?.closedAt ?? new Date(0);
  const end = new Date();

  const expenseAgg = await prisma.journalEntry.aggregate({
    where: {
      tenantId,
      status: "posted",
      postedAt: { gt: start, lte: end },
    },
    _sum: { amountMinor: true },
  });
  const expenseMinor = expenseAgg._sum.amountMinor ?? 0;

  const revenueMinor = cashMinor + cardMinor + otherMinor;
  const netMinor = revenueMinor - expenseMinor;
  const closedAtIso = new Date().toISOString();

  const snapshot = {
    revenueMinor,
    revenueCashMinor: cashMinor,
    revenueCardMinor: cardMinor,
    revenueOtherMinor: otherMinor,
    expenseMinor,
    netMinor,
    closedAtIso,
  };

  await prisma.dayClose.create({
    data: {
      tenantId,
      businessDate: ymd,
      closedById: authUser.userId,
      source: "mini-app",
      snapshot,
      memo: memo?.trim() || null,
    },
  });

  return NextResponse.json({ ok: true, businessDate: ymd });
}
