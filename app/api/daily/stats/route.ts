import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [entries, pendingCount, documentCount] = await Promise.all([
    prisma.journalEntry.findMany({
      where: {
        tenantId: authUser.tenantId,
        createdAt: { gte: todayStart },
        status: { in: ["draft", "posted"] },
      },
      select: { amountMinor: true },
    }),
    prisma.document.count({ where: { tenantId: authUser.tenantId, status: "needs_review" } }),
    prisma.document.count({ where: { tenantId: authUser.tenantId, createdAt: { gte: todayStart } } }),
  ]);

  const totalExpense = entries.reduce((sum: number, e: { amountMinor: number }) => sum + e.amountMinor, 0);

  return NextResponse.json({ totalExpense, documentCount, pendingCount });
}
