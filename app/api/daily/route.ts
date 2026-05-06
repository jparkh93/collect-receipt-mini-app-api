import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { prisma } from "@/lib/prisma";

function businessDateYmd(timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());
}

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId)
    return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const tenant = await prisma.tenant.findUnique({
    where: { id: authUser.tenantId },
    select: { timezone: true },
  });
  if (!tenant)
    return NextResponse.json({ error: "테넌트를 찾을 수 없습니다." }, { status: 404 });

  const tenantId = authUser.tenantId;
  const ymd = businessDateYmd(tenant.timezone);

  const todayClose = await prisma.dayClose.findUnique({
    where: { tenantId_businessDate: { tenantId, businessDate: ymd } },
  });

  const previousClose = await prisma.dayClose.findFirst({
    where: { tenantId, businessDate: { lt: ymd } },
    orderBy: { businessDate: "desc" },
    select: { closedAt: true },
  });

  const start = previousClose?.closedAt ?? new Date(0);
  const end = todayClose?.closedAt ?? new Date();

  const expenseAgg = await prisma.journalEntry.aggregate({
    where: {
      tenantId,
      status: "posted",
      postedAt: { gt: start, lte: end },
    },
    _sum: { amountMinor: true },
  });
  const expenseMinor = expenseAgg._sum.amountMinor ?? 0;

  const draftCount = await prisma.journalEntry.count({
    where: {
      tenantId,
      status: "draft",
      createdAt: { gt: previousClose?.closedAt ?? new Date(0) },
    },
  });

  const history = await prisma.dayClose.findMany({
    where: { tenantId },
    orderBy: { closedAt: "desc" },
    take: 14,
    select: {
      businessDate: true,
      snapshot: true,
      memo: true,
      closedAt: true,
    },
  });

  let snapshot: Record<string, unknown> | null = null;
  if (todayClose?.snapshot && typeof todayClose.snapshot === "object") {
    const s = todayClose.snapshot as Record<string, unknown>;
    if (typeof s.revenueMinor === "number") {
      snapshot = {
        revenueMinor: s.revenueMinor,
        revenueCashMinor: s.revenueCashMinor ?? 0,
        revenueCardMinor: s.revenueCardMinor ?? 0,
        revenueOtherMinor: s.revenueOtherMinor ?? 0,
        expenseMinor: s.expenseMinor ?? 0,
        netMinor: s.netMinor ?? 0,
        closedAtIso: s.closedAtIso ?? todayClose.closedAt.toISOString(),
      };
    }
  }

  return NextResponse.json({
    businessDate: ymd,
    closed: !!todayClose,
    snapshot,
    memo: todayClose?.memo ?? null,
    expenseMinor,
    draftCount,
    history: history.map((h) => ({
      businessDate: h.businessDate,
      snapshot: h.snapshot,
      memo: h.memo,
      closedAt: h.closedAt.toISOString(),
    })),
  });
}
