import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabase } from "@/lib/supabase";
import { getAuthUser, unauthorized } from "@/lib/toss-auth";
import {
  extractReceiptFromImage,
  extractReceiptFromImages,
} from "@/lib/ai-receipt";
import {
  generateDocumentTitle,
  generateDocumentSummary,
  generateDocumentTitleSummaryAi,
} from "@/lib/ai-meta";
import { isGeminiConfigured } from "@/lib/gemini";

const BUCKET = "documents";

function buildSearchText(parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join("\n").slice(0, 20000) || null;
}

function parseBusinessDateYmd(s: string | null): Date | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authUser = getAuthUser(req);
  if (!authUser) return unauthorized();
  if (!authUser.tenantId)
    return NextResponse.json({ error: "테넌트를 선택해주세요." }, { status: 400 });

  const { id } = await params;
  const tenantId = authUser.tenantId;

  const doc = await prisma.document.findFirst({
    where: { id, tenantId, deletedAt: null },
    include: {
      pages: { orderBy: { ordinal: "asc" } },
      journalEntry: { select: { id: true, status: true } },
    },
  });
  if (!doc) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const imagePages: { mimeType: string; base64: string }[] = [];
  for (const page of doc.pages) {
    const mime = page.mimeType ?? "application/octet-stream";
    if (!mime.startsWith("image/") && mime !== "application/pdf") continue;
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(page.storagePath);
    if (error || !data) continue;
    const buf = Buffer.from(await data.arrayBuffer());
    imagePages.push({ mimeType: mime, base64: buf.toString("base64") });
  }

  if (imagePages.length === 0) {
    return NextResponse.json({ error: "처리 가능한 이미지가 없습니다." }, { status: 400 });
  }

  const extracted =
    imagePages.length > 1
      ? await extractReceiptFromImages(imagePages)
      : await extractReceiptFromImage(imagePages[0]);

  if (!extracted) {
    return NextResponse.json(
      { error: "AI 인식에 실패했습니다. 잠시 후 다시 시도하세요." },
      { status: 500 },
    );
  }

  const vendorName = extracted.vendorName ?? null;
  const amountMinor = extracted.amountMinor ?? null;
  const ocrRawText = extracted.ocrRawText?.trim() ? extracted.ocrRawText : null;
  const paymentMethod = extracted.paymentMethod ?? null;
  const businessDate = parseBusinessDateYmd(extracted.date ?? null);
  const typeData =
    Array.isArray(extracted.items) && extracted.items.length > 0
      ? { extractedItems: extracted.items }
      : {};

  let title: string;
  let summary: string;
  if (isGeminiConfigured()) {
    const ai = await generateDocumentTitleSummaryAi({
      type: doc.type,
      vendorName,
      amountMinor,
      ocrRawText,
      items: extracted.items,
      createdAt: doc.createdAt,
    });
    if (ai) {
      title = ai.title;
      summary = ai.summary;
    } else {
      title = generateDocumentTitle({ type: doc.type, vendorName, amountMinor, createdAt: doc.createdAt });
      summary = generateDocumentSummary({ vendorName, amountMinor, ocrRawText });
    }
  } else {
    title = generateDocumentTitle({ type: doc.type, vendorName, amountMinor, createdAt: doc.createdAt });
    summary = generateDocumentSummary({ vendorName, amountMinor, ocrRawText });
  }

  await prisma.document.update({
    where: { id },
    data: {
      vendorName,
      amountMinor,
      ocrRawText,
      paymentMethod,
      businessDate,
      typeData,
      title,
      summary,
      titleUserEdited: false,
      searchText: buildSearchText([title, summary, ocrRawText, vendorName]),
      status: "needs_review",
    },
  });

  if (doc.journalEntry) {
    await prisma.journalEntry.update({
      where: { id: doc.journalEntry.id },
      data: {
        amountMinor: amountMinor ?? 0,
        paymentMethod,
        description: title,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
