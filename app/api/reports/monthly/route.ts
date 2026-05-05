import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  return NextResponse.json({
    revenue: 0,
    expense: 0,
    net: 0,
    count: 0,
    prevRevenue: 0,
    prevExpense: 0,
    pctChangeExpense: null,
    pctChangeRevenue: null,
    dailyChart: [],
  });
}
