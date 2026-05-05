import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { failStaleStagingJobs, runProcessJob } from "@/lib/documents-process";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  await failStaleStagingJobs(authUser.tenantId);

  const stagedCount = await prisma.stagedUpload.count({ where: { tenantId: authUser.tenantId } });
  if (stagedCount === 0) {
    return NextResponse.json({ error: "대기 중인 파일이 없습니다." }, { status: 400 });
  }

  const existing = await prisma.stagingProcessJob.findFirst({
    where: {
      tenantId: authUser.tenantId,
      status: { in: ["running", "awaiting_confirmation", "finalizing"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return NextResponse.json({ jobId: existing.id, resumed: true }, { status: 202 });
  }

  const job = await prisma.stagingProcessJob.create({
    data: {
      tenantId: authUser.tenantId,
      startedById: authUser.userId,
      status: "running",
    },
  });

  void runProcessJob(job.id, authUser.tenantId, authUser.userId);

  return NextResponse.json({ jobId: job.id, resumed: false }, { status: 202 });
}
