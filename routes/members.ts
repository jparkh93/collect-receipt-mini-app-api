import { Hono } from "hono";
import { requireAuth } from "../middleware/toss-auth";
import type { AppEnv } from "../types";

export const membersRoutes = new Hono<AppEnv>();

membersRoutes.use("*", requireAuth);

// GET /api/members — 팀원 목록
membersRoutes.get("/", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);
  return c.json({ members: [] });
});

// POST /api/members/invite — 초대
membersRoutes.post("/invite", async (c) => {
  return c.json({ ok: true });
});
