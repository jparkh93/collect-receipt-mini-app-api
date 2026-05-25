import { NextRequest, NextResponse, after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { runFinalizeJob } from "@/lib/documents-process";

export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { jobId } = await params;
  const job = await prisma.stagingProcessJob.findFirst({
    where: { id: jobId, tenantId: authUser.tenantId, status: "awaiting_confirmation" },
  });
  if (!job) return NextResponse.json({ error: "확인할 작업이 없습니다." }, { status: 404 });

  await prisma.stagingProcessJob.update({
    where: { id: jobId },
    data: { status: "finalizing", progress: Prisma.JsonNull },
  });

  after(() => runFinalizeJob(jobId, authUser.tenantId!, authUser.userId));

  return NextResponse.json({ ok: true });
}
