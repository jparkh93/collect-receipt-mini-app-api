import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { prisma } from "@/lib/prisma";

const PAYMENT_LABELS: Record<string, string> = {
  card: "카드",
  cash: "현금",
  transfer: "이체",
  unknown: "미정",
};

const PAYMENT_ORDER = ["card", "cash", "transfer", "unknown"];

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId)
    return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { searchParams } = req.nextUrl;
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()), 10);
  const month = parseInt(searchParams.get("month") || String(new Date().getMonth() + 1), 10);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "올바른 연/월을 입력해주세요." }, { status: 400 });
  }

  const tenantId = authUser.tenantId;

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const fromYmd = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const toYmd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevStart = new Date(Date.UTC(prevYear, prevMonth - 1, 1, 0, 0, 0, 0));
  const prevEnd = new Date(Date.UTC(prevYear, prevMonth, 0, 23, 59, 59, 999));

  const prevFromYmd = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
  const prevLastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const prevToYmd = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(prevLastDay).padStart(2, "0")}`;

  const wherePosted = {
    tenantId,
    status: "posted" as const,
    postedAt: { gte: start, lte: end },
  };

  const [expenseAgg, entries, dayCloses, prevExpenseAgg, prevDayCloses] = await Promise.all([
    prisma.journalEntry.aggregate({
      where: wherePosted,
      _sum: { amountMinor: true },
      _count: true,
    }),
    prisma.journalEntry.findMany({
      where: wherePosted,
      select: { amountMinor: true, paymentMethod: true, postedAt: true },
    }),
    prisma.dayClose.findMany({
      where: { tenantId, businessDate: { gte: fromYmd, lte: toYmd } },
      select: { snapshot: true },
    }),
    prisma.journalEntry.aggregate({
      where: {
        tenantId,
        status: "posted",
        postedAt: { gte: prevStart, lte: prevEnd },
      },
      _sum: { amountMinor: true },
      _count: true,
    }),
    prisma.dayClose.findMany({
      where: { tenantId, businessDate: { gte: prevFromYmd, lte: prevToYmd } },
      select: { snapshot: true },
    }),
  ]);

  const expenseTotal = expenseAgg._sum.amountMinor ?? 0;
  const expenseCount = expenseAgg._count;

  // Payment method breakdown
  const methodMap = new Map<string, { amount: number; count: number }>();
  const dailyMap = new Map<string, number>();

  for (const e of entries) {
    const key = e.paymentMethod ?? "unknown";
    const cur = methodMap.get(key) ?? { amount: 0, count: 0 };
    cur.amount += e.amountMinor;
    cur.count += 1;
    methodMap.set(key, cur);

    if (e.postedAt) {
      const d = e.postedAt.toISOString().slice(0, 10);
      dailyMap.set(d, (dailyMap.get(d) ?? 0) + e.amountMinor);
    }
  }

  const paymentBreakdown = PAYMENT_ORDER
    .filter((k) => methodMap.has(k))
    .map((k) => ({
      method: k,
      label: PAYMENT_LABELS[k] ?? k,
      amount: methodMap.get(k)!.amount,
      count: methodMap.get(k)!.count,
    }));

  const dailyChart = Array.from(dailyMap.entries())
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Revenue from DayClose snapshots
  let revTotal = 0, revCash = 0, revCard = 0, revOther = 0;
  for (const c of dayCloses) {
    const s = c.snapshot as Record<string, unknown> | null;
    if (!s || typeof s.revenueMinor !== "number") continue;
    revTotal += s.revenueMinor;
    if (typeof s.revenueCashMinor === "number") revCash += s.revenueCashMinor;
    if (typeof s.revenueCardMinor === "number") revCard += s.revenueCardMinor;
    if (typeof s.revenueOtherMinor === "number") revOther += s.revenueOtherMinor;
    else if (typeof s.revenueDeliveryMinor === "number") revOther += s.revenueDeliveryMinor;
  }

  // Previous month
  const prevExpenseTotal = prevExpenseAgg._sum.amountMinor ?? 0;
  let prevRevTotal = 0;
  for (const c of prevDayCloses) {
    const s = c.snapshot as Record<string, unknown> | null;
    if (!s || typeof s.revenueMinor !== "number") continue;
    prevRevTotal += s.revenueMinor;
  }

  return NextResponse.json({
    year,
    month,
    expense: { total: expenseTotal, count: expenseCount },
    revenue: {
      total: revTotal,
      cash: revCash,
      card: revCard,
      other: revOther,
      dayCount: dayCloses.length,
    },
    net: revTotal - expenseTotal,
    paymentBreakdown,
    dailyChart,
    prevMonth: { expense: prevExpenseTotal, revenue: prevRevTotal },
  });
}
