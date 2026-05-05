import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import { failStaleStagingJobs, serializeJobWithProposal } from "@/lib/documents-process";

export async function GET(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId) return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  await failStaleStagingJobs(authUser.tenantId);

  const jobId = req.nextUrl.searchParams.get("jobId");

  if (jobId) {
    const job = await prisma.stagingProcessJob.findFirst({
      where: { id: jobId, tenantId: authUser.tenantId },
    });
    if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await serializeJobWithProposal(job));
  }

  const active = await prisma.stagingProcessJob.findFirst({
    where: {
      tenantId: authUser.tenantId,
      status: { in: ["running", "awaiting_confirmation", "finalizing"] },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(active ? await serializeJobWithProposal(active) : null);
}
