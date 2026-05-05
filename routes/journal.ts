import { Hono } from "hono";
import { requireAuth } from "../middleware/toss-auth";
import { prisma } from "../lib/prisma";
import type { AppEnv } from "../types";

export const journalRoutes = new Hono<AppEnv>();

journalRoutes.use("*", requireAuth);

// GET /api/journal — 지출 내역 목록
journalRoutes.get("/", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const entries = await prisma.journalEntry.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      description: true,
      amountMinor: true,
      status: true,
      paymentMethod: true,
      createdAt: true,
    },
  });

  return c.json({
    entries: entries.map((e) => ({
      ...e,
      amount: e.amountMinor,
    })),
  });
});

// GET /api/journal/:id — 지출 상세
journalRoutes.get("/:id", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const id = c.req.param("id");
  const entry = await prisma.journalEntry.findFirst({
    where: { id, tenantId },
    include: { document: { select: { id: true, title: true } } },
  });
  if (!entry) return c.json({ error: "지출을 찾을 수 없습니다." }, 404);

  return c.json({ entry });
});

// POST /api/journal — 지출 등록
journalRoutes.post("/", async (c) => {
  return c.json({ ok: true });
});

// PATCH /api/journal/:id — 지출 수정
journalRoutes.patch("/:id", async (c) => {
  return c.json({ ok: true });
});

// POST /api/journal/:id/post — 승인
journalRoutes.post("/:id/post", async (c) => {
  return c.json({ ok: true });
});

// DELETE /api/journal/:id — 삭제
journalRoutes.delete("/:id", async (c) => {
  return c.json({ ok: true });
});
