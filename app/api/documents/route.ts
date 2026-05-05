import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const documents = await prisma.document.findMany({
    where: { tenantId: authUser.tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      vendorName: true,
      amountMinor: true,
      businessDate: true,
      paymentMethod: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ documents });
}
