import { Hono } from "hono";
import { requireAuth } from "../middleware/toss-auth";
import { prisma } from "../lib/prisma";
import type { AppEnv } from "../types";

export const dailyRoutes = new Hono<AppEnv>();

dailyRoutes.use("*", requireAuth);

// GET /api/daily/stats — today's summary stats for home page
dailyRoutes.get("/stats", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [entries, pendingCount, documentCount] = await Promise.all([
    prisma.journalEntry.findMany({
      where: {
        tenantId,
        createdAt: { gte: todayStart },
        status: { in: ["draft", "posted"] },
      },
      select: { amountMinor: true },
    }),
    prisma.document.count({
      where: { tenantId, status: "needs_review" },
    }),
    prisma.document.count({
      where: { tenantId, createdAt: { gte: todayStart } },
    }),
  ]);

  const totalExpense = entries.reduce((sum, e) => sum + e.amountMinor, 0);

  return c.json({ totalExpense, documentCount, pendingCount });
});

// GET /api/daily — 일일 보고 데이터
dailyRoutes.get("/", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);
  return c.json({ today: null, expense: 0, draftCount: 0, closed: false });
});

// POST /api/daily/close — 마감
dailyRoutes.post("/close", async (c) => {
  return c.json({ ok: true });
});

// POST /api/daily/reopen — 마감 취소
dailyRoutes.post("/reopen", async (c) => {
  return c.json({ ok: true });
});
