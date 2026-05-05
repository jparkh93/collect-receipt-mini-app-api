import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthUser, signToken, unauthorized } from "@/lib/toss-auth";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();

  const body = await req.json();
  const name = (body.name ?? "").trim();
  const brnRaw = (body.businessRegistrationNumber ?? "").trim();

  if (!name) {
    return NextResponse.json({ error: "매장 이름을 입력하세요." }, { status: 400 });
  }

  const digits = brnRaw.replace(/[^0-9]/g, "");
  if (digits.length !== 10) {
    return NextResponse.json({ error: "사업자등록번호는 숫자 10자리로 입력하세요." }, { status: 400 });
  }
  const businessRegistrationNumber = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;

  const existing = await prisma.tenant.findFirst({
    where: { businessRegistrationNumber },
    select: { id: true, name: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: `이미 등록된 사업자등록번호입니다. (${existing.name})` },
      { status: 409 },
    );
  }

  const tenant = await prisma.tenant.create({
    data: { name, businessRegistrationNumber },
  });

  await prisma.membership.create({
    data: { tenantId: tenant.id, userId: authUser.userId, role: "owner" },
  });

  const token = signToken({ userId: authUser.userId, tenantId: tenant.id });

  return NextResponse.json({ ok: true, token, tenant: { id: tenant.id, name: tenant.name } });
}
