import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const staged = await prisma.stagedUpload.findMany({
    where: { tenantId: authUser.tenantId },
    orderBy: { createdAt: "asc" },
    select: { id: true, originalName: true, mimeType: true, createdAt: true },
  });

  return NextResponse.json({ staged });
}
