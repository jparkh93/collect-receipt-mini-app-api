import { Hono } from "hono";
import { handle } from "hono/vercel";
import { cors } from "hono/cors";
import { authRoutes } from "../routes/auth";
import { onboardingRoutes } from "../routes/onboarding";
import { documentsRoutes } from "../routes/documents";
import { journalRoutes } from "../routes/journal";
import { dailyRoutes } from "../routes/daily";
import { reportsRoutes } from "../routes/reports";
import { chatRoutes } from "../routes/chat";
import { membersRoutes } from "../routes/members";

const app = new Hono().basePath("/api");

app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  }),
);

app.get("/health", (c) => c.json({ ok: true }));

app.route("/auth", authRoutes);
app.route("/onboarding", onboardingRoutes);
app.route("/documents", documentsRoutes);
app.route("/journal", journalRoutes);
app.route("/daily", dailyRoutes);
app.route("/reports", reportsRoutes);
app.route("/chat", chatRoutes);
app.route("/members", membersRoutes);

export default handle(app);
