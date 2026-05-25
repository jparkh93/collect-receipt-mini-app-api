import { NextRequest, NextResponse } from "next/server";

const ALLOWED_ORIGINS = [
  "https://collect-receipt-mini-app-api.vercel.app",
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.toss\.im$/.test(origin)) return true;
  if (
    process.env.NODE_ENV === "development" &&
    /^http:\/\/localhost(:\d+)?$/.test(origin)
  ) {
    return true;
  }
  return false;
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin") ?? "";
  const allowed = isAllowedOrigin(origin);

  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };
    if (allowed) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return new NextResponse(null, { status: 204, headers });
  }

  const res = NextResponse.next();
  if (allowed) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
