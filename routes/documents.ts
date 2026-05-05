import { Hono } from "hono";
import { randomUUID } from "crypto";
import { Prisma, DocumentType } from "@prisma/client";
import { requireAuth } from "../middleware/toss-auth";
import { prisma } from "../lib/prisma";
import { supabase } from "../lib/supabase";
import { groupStagedImageIdsWithCategories } from "../lib/ai-group";
import { extractReceiptFromImages } from "../lib/ai-receipt";
import {
  generateDocumentTitleSummaryAi,
  generateDocumentTitleFallback,
  generateDocumentSummaryFallback,
} from "../lib/ai-meta";
import type { AppEnv } from "../types";

const BUCKET = "documents";

export const documentsRoutes = new Hono<AppEnv>();
documentsRoutes.use("*", requireAuth);

// GET /api/documents/staged — staged uploads list
documentsRoutes.get("/staged", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const staged = await prisma.stagedUpload.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      createdAt: true,
    },
  });

  return c.json({ staged });
});

// POST /api/documents/stage — upload a file to staging
documentsRoutes.post("/stage", async (c) => {
  const { userId, tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const body = await c.req.parseBody();
  const file = body["file"];

  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "파일을 선택하세요." }, 400);
  }

  const id = randomUUID();
  const safeName = file.name.replace(/[^\w.\-가-힣]/g, "_").slice(0, 120);
  const storagePath = `${tenantId}/staged/${id}/${safeName}`;

  const buf = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "application/octet-stream";

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType: mime, upsert: false });

  if (upErr) {
    return c.json({ error: `업로드 실패: ${upErr.message}` }, 500);
  }

  await prisma.stagedUpload.create({
    data: {
      id,
      tenantId,
      uploadedById: userId,
      storagePath,
      originalName: file.name,
      mimeType: mime,
      sizeBytes: buf.length,
    },
  });

  return c.json({ ok: true, stagedId: id });
});

// POST /api/documents/stage-base64 — upload from camera/album base64
documentsRoutes.post("/stage-base64", async (c) => {
  const { userId, tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const { base64, fileName, mimeType } = await c.req.json<{
    base64: string;
    fileName?: string;
    mimeType?: string;
  }>();

  if (!base64) return c.json({ error: "이미지 데이터가 없습니다." }, 400);

  const id = randomUUID();
  const mime = mimeType || "image/jpeg";
  const name = fileName || `photo_${Date.now()}.jpg`;
  const safeName = name.replace(/[^\w.\-가-힣]/g, "_").slice(0, 120);
  const storagePath = `${tenantId}/staged/${id}/${safeName}`;

  const buf = Buffer.from(base64, "base64");

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType: mime, upsert: false });

  if (upErr) {
    return c.json({ error: `업로드 실패: ${upErr.message}` }, 500);
  }

  await prisma.stagedUpload.create({
    data: {
      id,
      tenantId,
      uploadedById: userId,
      storagePath,
      originalName: name,
      mimeType: mime,
      sizeBytes: buf.length,
    },
  });

  return c.json({ ok: true, stagedId: id });
});

// DELETE /api/documents/staged/:id — remove from staging
documentsRoutes.delete("/staged/:id", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const stagedId = c.req.param("id");
  const row = await prisma.stagedUpload.findFirst({
    where: { id: stagedId, tenantId },
  });
  if (!row) return c.json({ error: "항목을 찾을 수 없습니다." }, 404);

  await supabase.storage.from(BUCKET).remove([row.storagePath]);
  await prisma.stagedUpload.delete({ where: { id: stagedId } });

  return c.json({ ok: true });
});

// GET /api/documents/staged/:id/file — serve staged file thumbnail
documentsRoutes.get("/staged/:id/file", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const stagedId = c.req.param("id");
  const row = await prisma.stagedUpload.findFirst({
    where: { id: stagedId, tenantId },
    select: { storagePath: true, mimeType: true },
  });
  if (!row) return c.json({ error: "not found" }, 404);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(row.storagePath);
  if (error || !data) return c.json({ error: "파일 로드 실패" }, 500);

  const buf = Buffer.from(await data.arrayBuffer());
  return new Response(buf, {
    headers: {
      "Content-Type": row.mimeType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// --- Processing Job APIs ---

const STAGING_JOB_STALE_MS = 90 * 60 * 1000;

async function failStaleStagingJobs(tenantId: string) {
  const cutoff = new Date(Date.now() - STAGING_JOB_STALE_MS);
  await prisma.stagingProcessJob.updateMany({
    where: {
      tenantId,
      status: { in: ["running", "finalizing"] },
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "failed",
      error: "이전 작업이 응답 없이 중단되었습니다.",
      progress: Prisma.JsonNull,
    },
  });
}

// GET /api/documents/process-job — poll job status
documentsRoutes.get("/process-job", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  await failStaleStagingJobs(tenantId);
  const jobId = c.req.query("jobId");

  if (jobId) {
    const job = await prisma.stagingProcessJob.findFirst({
      where: { id: jobId, tenantId },
    });
    if (!job) return c.json({ error: "not_found" }, 404);
    return c.json(await serializeJobWithProposal(job));
  }

  const active = await prisma.stagingProcessJob.findFirst({
    where: {
      tenantId,
      status: { in: ["running", "awaiting_confirmation", "finalizing"] },
    },
    orderBy: { createdAt: "desc" },
  });

  return c.json(active ? await serializeJobWithProposal(active) : null);
});

// POST /api/documents/process — start AI processing
documentsRoutes.post("/process", async (c) => {
  const { userId, tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  await failStaleStagingJobs(tenantId);

  const stagedCount = await prisma.stagedUpload.count({ where: { tenantId } });
  if (stagedCount === 0) {
    return c.json({ error: "대기 중인 파일이 없습니다." }, 400);
  }

  const existing = await prisma.stagingProcessJob.findFirst({
    where: {
      tenantId,
      status: { in: ["running", "awaiting_confirmation", "finalizing"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return c.json({ jobId: existing.id, resumed: true }, 202);
  }

  const job = await prisma.stagingProcessJob.create({
    data: {
      tenantId,
      startedById: userId,
      status: "running",
    },
  });

  void runProcessJob(job.id, tenantId, userId);

  return c.json({ jobId: job.id, resumed: false }, 202);
});

// POST /api/documents/process-job/:jobId/confirm — confirm proposal
documentsRoutes.post("/process-job/:jobId/confirm", async (c) => {
  const { userId, tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const jobId = c.req.param("jobId");
  const job = await prisma.stagingProcessJob.findFirst({
    where: { id: jobId, tenantId, status: "awaiting_confirmation" },
  });
  if (!job) return c.json({ error: "확인할 작업이 없습니다." }, 404);

  await prisma.stagingProcessJob.update({
    where: { id: jobId },
    data: { status: "finalizing", progress: Prisma.JsonNull },
  });

  void runFinalizeJob(jobId, tenantId, userId);

  return c.json({ ok: true });
});

// POST /api/documents/process-job/:jobId/cancel — cancel job
documentsRoutes.post("/process-job/:jobId/cancel", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const jobId = c.req.param("jobId");
  await prisma.stagingProcessJob.update({
    where: { id: jobId },
    data: {
      status: "failed",
      error: "사용자가 중단했습니다.",
      progress: Prisma.JsonNull,
    },
  });

  return c.json({ ok: true });
});

// --- Review Proposal APIs ---

// PATCH /api/documents/process-job/:jobId/groups/:groupId/category — change group category
documentsRoutes.patch("/process-job/:jobId/groups/:groupId/category", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const { jobId, groupId } = c.req.param();
  const { category } = await c.req.json<{ category: string }>();

  if (!["expense", "contract", "other"].includes(category)) {
    return c.json({ error: "유효하지 않은 카테고리입니다." }, 400);
  }

  const group = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId },
  });
  if (!group) return c.json({ error: "그룹을 찾을 수 없습니다." }, 404);

  await prisma.stagingGroup.update({
    where: { id: groupId },
    data: { category: category as DocumentType },
  });

  return c.json({ ok: true });
});

// POST /api/documents/process-job/:jobId/groups/:groupId/ungroup — split group into individual items
documentsRoutes.post("/process-job/:jobId/groups/:groupId/ungroup", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const { jobId, groupId } = c.req.param();

  const group = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId },
    include: { items: true },
  });
  if (!group) return c.json({ error: "그룹을 찾을 수 없습니다." }, 404);
  if (group.items.length <= 1) {
    return c.json({ error: "1개 항목은 해체할 수 없습니다." }, 400);
  }

  for (const item of group.items) {
    const newGroup = await prisma.stagingGroup.create({
      data: { tenantId, jobId, category: group.category },
    });
    await prisma.stagedUpload.update({
      where: { id: item.id },
      data: { groupId: newGroup.id },
    });
  }

  await prisma.stagingGroup.delete({ where: { id: groupId } });

  return c.json({ ok: true });
});

// POST /api/documents/process-job/:jobId/groups/:groupId/move — move items between groups
documentsRoutes.post("/process-job/:jobId/groups/:groupId/move", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const { jobId, groupId } = c.req.param();
  const { stagedIds, targetGroupId } = await c.req.json<{
    stagedIds: string[];
    targetGroupId?: string;
  }>();

  if (!stagedIds || stagedIds.length === 0) {
    return c.json({ error: "이동할 항목을 선택하세요." }, 400);
  }

  const srcGroup = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId },
    include: { items: true },
  });
  if (!srcGroup) return c.json({ error: "원본 그룹을 찾을 수 없습니다." }, 404);

  let destGroupId: string;
  if (targetGroupId) {
    const dest = await prisma.stagingGroup.findFirst({
      where: { id: targetGroupId, jobId, tenantId },
    });
    if (!dest) return c.json({ error: "대상 그룹을 찾을 수 없습니다." }, 404);
    destGroupId = dest.id;
  } else {
    const newGroup = await prisma.stagingGroup.create({
      data: { tenantId, jobId, category: srcGroup.category },
    });
    destGroupId = newGroup.id;
  }

  await prisma.stagedUpload.updateMany({
    where: { id: { in: stagedIds }, groupId },
    data: { groupId: destGroupId },
  });

  const remaining = await prisma.stagedUpload.count({ where: { groupId } });
  if (remaining === 0) {
    await prisma.stagingGroup.delete({ where: { id: groupId } });
  }

  return c.json({ ok: true, targetGroupId: destGroupId });
});

// DELETE /api/documents/process-job/:jobId/groups/:groupId/items/:stagedId — remove item from processing
documentsRoutes.delete("/process-job/:jobId/groups/:groupId/items/:stagedId", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const { jobId, groupId, stagedId } = c.req.param();

  const group = await prisma.stagingGroup.findFirst({
    where: { id: groupId, jobId, tenantId },
  });
  if (!group) return c.json({ error: "그룹을 찾을 수 없습니다." }, 404);

  const item = await prisma.stagedUpload.findFirst({
    where: { id: stagedId, groupId },
  });
  if (!item) return c.json({ error: "항목을 찾을 수 없습니다." }, 404);

  await supabase.storage.from(BUCKET).remove([item.storagePath]);
  await prisma.stagedUpload.delete({ where: { id: stagedId } });

  const remaining = await prisma.stagedUpload.count({ where: { groupId } });
  if (remaining === 0) {
    await prisma.stagingGroup.delete({ where: { id: groupId } });
  }

  return c.json({ ok: true });
});

// GET /api/documents — document list (inbox)
documentsRoutes.get("/", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const documents = await prisma.document.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      vendorName: true,
      amountMinor: true,
      businessDate: true,
      paymentMethod: true,
      createdAt: true,
    },
  });

  return c.json({ documents });
});

// GET /api/documents/:id — document detail
documentsRoutes.get("/:id", async (c) => {
  const { tenantId } = c.get("user");
  if (!tenantId) return c.json({ error: "테넌트를 선택해주세요." }, 400);

  const id = c.req.param("id");
  const doc = await prisma.document.findFirst({
    where: { id, tenantId },
    include: { pages: { orderBy: { ordinal: "asc" } } },
  });
  if (!doc) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);

  return c.json({ document: doc });
});

// --- Background Processing ---

async function downloadBase64(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(storagePath);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  return buf.toString("base64");
}

async function runProcessJob(
  jobId: string,
  tenantId: string,
  userId: string,
) {
  try {
    const staged = await prisma.stagedUpload.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });

    if (staged.length === 0) {
      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: "대기 중인 파일이 없습니다.",
          progress: Prisma.JsonNull,
        },
      });
      return;
    }

    await prisma.stagingProcessJob.update({
      where: { id: jobId },
      data: {
        progress: { kind: "grouping", current: 0, total: staged.length } as unknown as Prisma.InputJsonValue,
      },
    });

    // Download images for AI grouping
    const items: { id: string; mimeType: string; base64: string }[] = [];
    for (const s of staged) {
      const base64 = await downloadBase64(s.storagePath);
      if (!base64) {
        throw new Error(`파일 다운로드 실패: ${s.originalName ?? s.id}`);
      }
      items.push({
        id: s.id,
        mimeType: s.mimeType ?? "image/jpeg",
        base64,
      });
    }

    // AI grouping + classification
    const groupResults = await groupStagedImageIdsWithCategories(items);

    // Persist groups to DB
    await prisma.stagingGroup.deleteMany({ where: { jobId } });

    for (const gr of groupResults) {
      const group = await prisma.stagingGroup.create({
        data: {
          tenantId,
          jobId,
          category: gr.category,
        },
      });
      await prisma.stagedUpload.updateMany({
        where: { id: { in: gr.ids } },
        data: { groupId: group.id },
      });
    }

    // Auto-finalize for single group with single item; otherwise await confirmation
    if (groupResults.length === 1 && groupResults[0].ids.length === 1) {
      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: { status: "finalizing", progress: Prisma.JsonNull },
      });
      await runFinalizeJob(jobId, tenantId, userId);
    } else {
      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: { status: "awaiting_confirmation", progress: Prisma.JsonNull },
      });
    }
  } catch (e) {
    await prisma.stagingGroup.deleteMany({ where: { jobId } });
    await prisma.stagingProcessJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: e instanceof Error ? e.message : "알 수 없는 오류",
        progress: Prisma.JsonNull,
      },
    });
  }
}

async function runFinalizeJob(
  jobId: string,
  tenantId: string,
  _userId: string,
) {
  try {
    const groups = await prisma.stagingGroup.findMany({
      where: { jobId },
      include: { items: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });

    if (groups.length === 0) {
      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: "확정할 묶음이 없습니다.",
          progress: Prisma.JsonNull,
        },
      });
      return;
    }

    const createdDocIds: string[] = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const rows = group.items;
      const type = group.category;

      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: {
          progress: {
            kind: "ocr",
            group: gi + 1,
            of: groups.length,
            pageCount: rows.length,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      const docId = randomUUID();
      const pageCreates: {
        ordinal: number;
        storagePath: string;
        originalName: string | null;
        mimeType: string | null;
      }[] = [];
      const imageDataForOcr: { mimeType: string; base64: string }[] = [];

      for (let ord = 0; ord < rows.length; ord++) {
        const row = rows[ord];
        const ordinal = ord + 1;
        const safeName =
          row.originalName?.replace(/[^\w.\-가-힣]/g, "_").slice(0, 120) ??
          `file_${ordinal}`;
        const destPath = `${tenantId}/${docId}/p${ordinal}_${safeName}`;
        const mime = row.mimeType ?? "application/octet-stream";

        const { data: fileData, error: dlErr } = await supabase.storage
          .from(BUCKET)
          .download(row.storagePath);
        if (dlErr || !fileData) {
          throw new Error(`파일 다운로드 실패: ${dlErr?.message ?? row.id}`);
        }

        const buf = Buffer.from(await fileData.arrayBuffer());
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(destPath, buf, { contentType: mime, upsert: false });
        if (upErr) throw new Error(`파일 저장 실패: ${upErr.message}`);

        await supabase.storage.from(BUCKET).remove([row.storagePath]);

        pageCreates.push({
          ordinal,
          storagePath: destPath,
          originalName: row.originalName,
          mimeType: mime,
        });

        if (mime.startsWith("image/")) {
          imageDataForOcr.push({ mimeType: mime, base64: buf.toString("base64") });
        }
      }

      // AI OCR extraction
      const extracted =
        type === "expense" && imageDataForOcr.length > 0
          ? await extractReceiptFromImages(imageDataForOcr)
          : null;

      const now = new Date();

      // AI title + summary generation
      let title: string;
      let summary: string;
      let ocrRawText: string | null = extracted?.ocrRawText ?? null;
      let vendorName: string | null = extracted?.vendorName ?? null;
      let amountMinor: number | null = extracted?.amountMinor ?? null;
      let paymentMethod: string | null = extracted?.paymentMethod ?? null;
      let businessDate: Date | null = null;

      if (extracted?.date) {
        const parsed = new Date(extracted.date);
        if (!isNaN(parsed.getTime())) businessDate = parsed;
      }

      const aiMeta = extracted
        ? await generateDocumentTitleSummaryAi({
            type,
            vendorName,
            amountMinor,
            ocrRawText,
            items: extracted.items,
            createdAt: now,
          })
        : null;

      if (aiMeta) {
        title = aiMeta.title;
        summary = aiMeta.summary;
      } else {
        title = generateDocumentTitleFallback({ type, vendorName, amountMinor, createdAt: now });
        summary = generateDocumentSummaryFallback({ vendorName, amountMinor, ocrRawText });
      }

      const searchText = [title, summary, ocrRawText].filter(Boolean).join(" ");

      await prisma.document.create({
        data: {
          id: docId,
          tenantId,
          type,
          status: "needs_review",
          title,
          summary,
          ocrRawText,
          vendorName,
          amountMinor,
          paymentMethod,
          businessDate,
          searchText,
          storagePath: pageCreates[0].storagePath,
          originalName: pageCreates[0].originalName,
          mimeType: pageCreates[0].mimeType,
          pages: {
            create: pageCreates.map((p) => ({
              ordinal: p.ordinal,
              storagePath: p.storagePath,
              originalName: p.originalName,
              mimeType: p.mimeType,
            })),
          },
        },
      });

      await prisma.stagedUpload.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      await prisma.stagingGroup.delete({ where: { id: group.id } });

      createdDocIds.push(docId);
    }

    await prisma.stagingProcessJob.update({
      where: { id: jobId },
      data: {
        status: "completed",
        documentIds: createdDocIds,
        progress: Prisma.JsonNull,
      },
    });
  } catch (e) {
    await prisma.stagingProcessJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: e instanceof Error ? e.message : "알 수 없는 오류",
        progress: Prisma.JsonNull,
      },
    });
  }
}

// --- Helpers ---

async function serializeJobWithProposal(job: {
  id: string;
  status: string;
  progress: Prisma.JsonValue;
  error: string | null;
  documentIds: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  const base = {
    id: job.id,
    status: job.status,
    progress: job.progress as Record<string, unknown> | null,
    error: job.error,
    documentIds: (job.documentIds as string[] | null) ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };

  if (job.status !== "awaiting_confirmation") return base;

  const groups = await prisma.stagingGroup.findMany({
    where: { jobId: job.id },
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, originalName: true, mimeType: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    ...base,
    proposal: {
      groups: groups.map((g) => ({
        id: g.id,
        category: g.category,
        items: g.items.map((s) => ({
          stagedId: s.id,
          originalName: s.originalName,
          mimeType: s.mimeType,
        })),
      })),
    },
  };
}
