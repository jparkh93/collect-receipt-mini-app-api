import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";

export async function POST(req: NextRequest) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  return NextResponse.json({ message: "Not implemented yet" }, { status: 501 });
}
