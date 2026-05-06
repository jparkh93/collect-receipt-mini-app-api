import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { groupStagedImageIdsWithCategories } from "@/lib/ai-group";
import { extractReceiptFromImages } from "@/lib/ai-receipt";
import {
  generateDocumentTitleSummaryAi,
  generateDocumentTitleFallback,
  generateDocumentSummaryFallback,
} from "@/lib/ai-meta";

const BUCKET = "documents";
const STAGING_JOB_STALE_MS = 90 * 60 * 1000;

async function downloadBase64(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  return buf.toString("base64");
}

export async function failStaleStagingJobs(tenantId: string) {
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

export async function serializeJobWithProposal(job: {
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

export async function runProcessJob(jobId: string, tenantId: string, userId: string) {
  try {
    const staged = await prisma.stagedUpload.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });

    if (staged.length === 0) {
      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: { status: "failed", error: "대기 중인 파일이 없습니다.", progress: Prisma.JsonNull },
      });
      return;
    }

    await prisma.stagingProcessJob.update({
      where: { id: jobId },
      data: {
        progress: { kind: "grouping", current: 0, total: staged.length } as unknown as Prisma.InputJsonValue,
      },
    });

    const items: { id: string; mimeType: string; base64: string }[] = [];
    for (const s of staged) {
      const base64 = await downloadBase64(s.storagePath);
      if (!base64) throw new Error(`파일 다운로드 실패: ${s.originalName ?? s.id}`);
      items.push({ id: s.id, mimeType: s.mimeType ?? "image/jpeg", base64 });
    }

    const groupResults = await groupStagedImageIdsWithCategories(items);

    await prisma.stagingGroup.deleteMany({ where: { jobId } });

    for (const gr of groupResults) {
      const group = await prisma.stagingGroup.create({
        data: { tenantId, jobId, category: gr.category },
      });
      await prisma.stagedUpload.updateMany({
        where: { id: { in: gr.ids } },
        data: { groupId: group.id },
      });
    }

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function runFinalizeJob(jobId: string, tenantId: string, _userId?: string) {
  try {
    const groups = await prisma.stagingGroup.findMany({
      where: { jobId },
      include: { items: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });

    if (groups.length === 0) {
      await prisma.stagingProcessJob.update({
        where: { id: jobId },
        data: { status: "failed", error: "확정할 묶음이 없습니다.", progress: Prisma.JsonNull },
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
          row.originalName?.replace(/[^\w.\-가-힣]/g, "_").slice(0, 120) ?? `file_${ordinal}`;
        const destPath = `${tenantId}/${docId}/p${ordinal}_${safeName}`;
        const mime = row.mimeType ?? "application/octet-stream";

        const { data: fileData, error: dlErr } = await supabase.storage
          .from(BUCKET)
          .download(row.storagePath);
        if (dlErr || !fileData) throw new Error(`파일 다운로드 실패: ${dlErr?.message ?? row.id}`);

        const buf = Buffer.from(await fileData.arrayBuffer());
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(destPath, buf, { contentType: mime, upsert: false });
        if (upErr) throw new Error(`파일 저장 실패: ${upErr.message}`);

        await supabase.storage.from(BUCKET).remove([row.storagePath]);

        pageCreates.push({ ordinal, storagePath: destPath, originalName: row.originalName, mimeType: mime });

        if (mime.startsWith("image/")) {
          imageDataForOcr.push({ mimeType: mime, base64: buf.toString("base64") });
        }
      }

      const extracted =
        type === "expense" && imageDataForOcr.length > 0
          ? await extractReceiptFromImages(imageDataForOcr)
          : null;

      const now = new Date();
      let title: string;
      let summary: string;
      const ocrRawText: string | null = extracted?.ocrRawText ?? null;
      const vendorName: string | null = extracted?.vendorName ?? null;
      const amountMinor: number | null = extracted?.amountMinor ?? null;
      const paymentMethod: string | null = extracted?.paymentMethod ?? null;
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

      const shouldAutoPost =
        type === "expense" && (amountMinor ?? 0) > 0 && paymentMethod != null;

      await prisma.document.create({
        data: {
          id: docId,
          tenantId,
          type,
          status: shouldAutoPost ? "linked" : "needs_review",
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

      if (type === "expense" && (amountMinor ?? 0) > 0) {
        await prisma.journalEntry.create({
          data: {
            tenantId,
            documentId: docId,
            description: title,
            amountMinor: amountMinor!,
            paymentMethod,
            status: shouldAutoPost ? "posted" : "draft",
            postedAt: shouldAutoPost ? new Date() : undefined,
          },
        });
      }

      await prisma.stagedUpload.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      await prisma.stagingGroup.delete({ where: { id: group.id } });
      createdDocIds.push(docId);
    }

    await prisma.stagingProcessJob.update({
      where: { id: jobId },
      data: { status: "completed", documentIds: createdDocIds, progress: Prisma.JsonNull },
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
