import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireTenantAuth } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const auth = await requireTenantAuth(req);
  if (auth.error) return auth.error;
  const authUser = auth.user;

  const documents = await prisma.document.findMany({
    where: { tenantId: authUser.tenantId, deletedAt: null },
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
