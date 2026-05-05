import { Hono } from "hono";
import { requireAuth } from "../middleware/toss-auth";
import type { AppEnv } from "../types";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.use("*", requireAuth);

// POST /api/chat/stream — SSE 채팅
chatRoutes.post("/stream", async (c) => {
  // TODO: Gemini streaming 구현
  return c.json({ message: "Not implemented yet" }, 501);
});
