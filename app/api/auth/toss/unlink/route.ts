import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Basic ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expected = process.env.TOSS_UNLINK_BASIC_AUTH;
  if (!expected || authHeader.slice(6) !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userKey } = await req.json();
  if (!userKey) {
    return NextResponse.json({ error: "userKey is required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { tossIdentityKey: userKey },
    include: {
      memberships: { select: { id: true, tenantId: true } },
    },
  });

  if (!user) {
    return NextResponse.json({ success: true });
  }

  const soleTenantIds: string[] = [];
  for (const m of user.memberships) {
    const memberCount = await prisma.membership.count({
      where: { tenantId: m.tenantId },
    });
    if (memberCount === 1) {
      soleTenantIds.push(m.tenantId);
    }
  }

  const txOps = [];

  if (soleTenantIds.length > 0) {
    txOps.push(
      prisma.dayClose.deleteMany({
        where: { tenantId: { in: soleTenantIds } },
      }),
      prisma.journalEntry.deleteMany({
        where: { tenantId: { in: soleTenantIds } },
      }),
      prisma.documentPage.deleteMany({
        where: { document: { tenantId: { in: soleTenantIds } } },
      }),
      prisma.document.deleteMany({
        where: { tenantId: { in: soleTenantIds } },
      }),
    );
  }

  txOps.push(
    prisma.stagedUpload.deleteMany({
      where: { uploadedById: user.id },
    }),
    prisma.chatMessage.deleteMany({
      where: { session: { userId: user.id } },
    }),
    prisma.chatSession.deleteMany({
      where: { userId: user.id },
    }),
    prisma.membership.deleteMany({
      where: { userId: user.id },
    }),
    prisma.user.delete({
      where: { id: user.id },
    }),
  );

  await prisma.$transaction(txOps);

  return NextResponse.json({ success: true });
}
