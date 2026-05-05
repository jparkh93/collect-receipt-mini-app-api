import { Hono } from "hono";
import { requireAuth } from "../middleware/toss-auth";
import type { AppEnv } from "../types";

export const reportsRoutes = new Hono<AppEnv>();

reportsRoutes.use("*", requireAuth);

// GET /api/reports/monthly?year=&month= — 월간 보고서
reportsRoutes.get("/monthly", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);
  return c.json({
    revenue: 0,
    expense: 0,
    net: 0,
    count: 0,
    prevRevenue: 0,
    prevExpense: 0,
    pctChangeExpense: null,
    pctChangeRevenue: null,
    dailyChart: [],
  });
});
