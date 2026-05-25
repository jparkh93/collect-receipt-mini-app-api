import { NextResponse } from "next/server";

export async function parseJsonBody<T = unknown>(req: Request): Promise<T | NextResponse> {
  try {
    return await req.json() as T;
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }
}
