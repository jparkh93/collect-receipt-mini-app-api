import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { jobId } = await params;

  const job = await prisma.stagingProcessJob.findFirst({
    where: { id: jobId, tenantId: authUser.tenantId },
  });
  if (!job) {
    return NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
  }

  await prisma.stagingProcessJob.update({
    where: { id: jobId },
    data: { status: "failed", error: "사용자가 중단했습니다.", progress: Prisma.JsonNull },
  });

  return NextResponse.json({ ok: true });
}
