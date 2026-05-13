import { prisma } from "@/lib/prisma";
import { documentTypeLabelKo } from "@/lib/ai-meta";
import type { DocumentStatus, DocumentType } from "@prisma/client";

export type ChatReply = { markdown: string };

const OCR_SLICE = 500;

function businessDateYmd(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone }).formatToParts(instant);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function zonedRangeUtc(
  fromYmd: string,
  toYmd: string,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedToUtc(`${fromYmd}T00:00:00`, timeZone);
  const end = zonedToUtc(`${toYmd}T23:59:59.999`, timeZone);
  return { start, end };
}

function zonedToUtc(localIso: string, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const target = new Date(localIso);
  const utcGuess = target.getTime();
  const formatted = fmt.formatToParts(new Date(utcGuess));
  const get = (t: string) =>
    formatted.find((p) => p.type === t)?.value ?? "0";

  const localAtGuess = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`,
  );
  const offset = localAtGuess.getTime() - utcGuess;
  return new Date(target.getTime() - offset);
}

function documentStatusLabelKo(s: DocumentStatus | string): string {
  switch (s) {
    case "processing":
      return "처리 중";
    case "needs_review":
      return "검토 필요";
    case "reviewed":
      return "검토 완료";
    case "linked":
      return "연결됨";
    case "error":
      return "오류";
    default:
      return s;
  }
}

function extractItems(typeData: unknown): string | null {
  if (!typeData || typeof typeData !== "object") return null;
  const td = typeData as Record<string, unknown>;
  if (!Array.isArray(td.extractedItems) || td.extractedItems.length === 0)
    return null;
  return (td.extractedItems as string[]).join(", ").slice(0, 200);
}

export async function toolGetDailyReport(
  tenantId: string,
  tenant: { timezone: string },
): Promise<ChatReply> {
  const ymd = businessDateYmd(new Date(), tenant.timezone);
  const closed = await prisma.dayClose.findUnique({
    where: { tenantId_businessDate: { tenantId, businessDate: ymd } },
  });
  const draftCount = await prisma.journalEntry.count({
    where: { tenantId, status: "draft" },
  });
  const status = closed ? "마감 완료" : "미마감";

  let revenueLine = "";
  if (closed?.snapshot && typeof closed.snapshot === "object") {
    const snap = closed.snapshot as Record<string, unknown>;
    if (typeof snap.revenueMinor === "number") {
      const total = (snap.revenueMinor as number).toLocaleString("ko-KR");
      if (typeof snap.revenueCashMinor === "number") {
        const cash = (snap.revenueCashMinor as number).toLocaleString("ko-KR");
        const card = (snap.revenueCardMinor as number).toLocaleString("ko-KR");
        const otherVal = (
          (snap.revenueOtherMinor ?? snap.revenueDeliveryMinor ?? 0) as number
        ).toLocaleString("ko-KR");
        revenueLine = `- 매출 합계: **${total}원** (현금 ${cash} / 카드 ${card} / 기타 ${otherVal})\n`;
      } else {
        revenueLine = `- 매출: **${total}원**\n`;
      }
      const expense = (snap.expenseMinor as number).toLocaleString("ko-KR");
      const net = (snap.netMinor as number).toLocaleString("ko-KR");
      revenueLine += `- 지출: **${expense}원** · 순이익: **${net}원**\n`;
    }
  }

  return {
    markdown:
      `오늘 영업일 **${ymd}** · **${status}**\n\n` +
      revenueLine +
      `- 미승인 지출: **${draftCount}**건\n` +
      `- [일일 보고서](/daily)`,
  };
}

export async function toolGetPnl(
  tenantId: string,
  tenant: { timezone: string },
  opts?: { fromYmd?: string; toYmd?: string },
): Promise<ChatReply> {
  const now = new Date();
  const defaultTo = businessDateYmd(now, tenant.timezone);
  const defaultFrom = `${defaultTo.slice(0, 7)}-01`;
  const fromYmd = opts?.fromYmd?.trim() || defaultFrom;
  const toYmd = opts?.toYmd?.trim() || defaultTo;
  const range = zonedRangeUtc(fromYmd, toYmd, tenant.timezone);

  const entries = await prisma.journalEntry.findMany({
    where: {
      tenantId,
      status: "posted",
      postedAt: { gte: range.start, lte: range.end },
    },
    select: { amountMinor: true },
  });

  if (entries.length === 0) {
    return {
      markdown:
        "선택 기간에 승인된 지출이 없습니다. 지출을 승인하면 반영됩니다.\n\n" +
        `[지출 리포트](/monthly?from=${fromYmd}&to=${toYmd})`,
    };
  }

  const totalExpense = entries.reduce((s, e) => s + e.amountMinor, 0);

  const dayCloses = await prisma.dayClose.findMany({
    where: { tenantId, businessDate: { gte: fromYmd, lte: toYmd } },
    select: { snapshot: true },
  });
  let totalRevenue = 0;
  for (const dc of dayCloses) {
    if (dc.snapshot && typeof dc.snapshot === "object") {
      const snap = dc.snapshot as Record<string, unknown>;
      if (typeof snap.revenueMinor === "number") {
        totalRevenue += snap.revenueMinor;
      }
    }
  }

  const net = totalRevenue - totalExpense;
  let md =
    `기간 **${fromYmd}** ~ **${toYmd}** 지출 합계: **${totalExpense.toLocaleString("ko-KR")}원** (${entries.length}건)\n\n`;

  if (totalRevenue > 0) {
    md +=
      `- 매출: **${totalRevenue.toLocaleString("ko-KR")}원**\n` +
      `- 지출: **${totalExpense.toLocaleString("ko-KR")}원**\n` +
      `- 순이익: **${net.toLocaleString("ko-KR")}원**\n\n`;
  }

  md += `[지출 리포트](/monthly?from=${fromYmd}&to=${toYmd})`;
  return { markdown: md };
}

export async function toolSearchDocuments(
  tenantId: string,
  q: string,
  opts?: { fromYmd?: string; toYmd?: string },
): Promise<ChatReply> {
  const where: Record<string, unknown> = {
    tenantId,
    deletedAt: null,
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { summary: { contains: q, mode: "insensitive" } },
      { vendorName: { contains: q, mode: "insensitive" } },
      { ocrRawText: { contains: q, mode: "insensitive" } },
    ],
  };

  if (opts?.fromYmd || opts?.toYmd) {
    const tz = "Asia/Seoul";
    const fromYmd = opts.fromYmd || "2000-01-01";
    const toYmd = opts.toYmd || "2099-12-31";
    const range = zonedRangeUtc(fromYmd, toYmd, tz);
    where.createdAt = { gte: range.start, lte: range.end };
  }

  const docs = await prisma.document.findMany({
    where,
    select: {
      id: true,
      title: true,
      summary: true,
      type: true,
      status: true,
      vendorName: true,
      amountMinor: true,
      ocrRawText: true,
      businessDate: true,
      typeData: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 8,
  });

  if (docs.length === 0) {
    return {
      markdown: `"${q}"에 맞는 문서가 없습니다. [문서함](/inbox)`,
    };
  }

  const list = docs
    .map((d) => {
      const amt =
        d.amountMinor != null
          ? `${d.amountMinor.toLocaleString("ko-KR")}원`
          : "금액 미상";
      const date = d.businessDate
        ? d.businessDate.toISOString().slice(0, 10)
        : d.createdAt.toISOString().slice(0, 10);
      const items = extractItems(d.typeData);
      const ocr = d.ocrRawText?.slice(0, OCR_SLICE) ?? "";

      let entry =
        `**[${d.title ?? "제목 없음"}](/inbox/${d.id})**\n` +
        `종류: ${documentTypeLabelKo(d.type)} | 상태: ${documentStatusLabelKo(d.status)}\n` +
        `금액: ${amt} | 공급자: ${d.vendorName ?? "미상"} | 날짜: ${date}`;
      if (d.summary) entry += `\n요약: ${d.summary.slice(0, 120)}`;
      if (items) entry += `\n품목: ${items}`;
      if (ocr) entry += `\nOCR: ${ocr}`;
      return entry;
    })
    .join("\n\n---\n\n");

  return {
    markdown: `문서 검색 결과 (${docs.length}건):\n\n${list}\n\n[문서함 전체](/inbox?q=${encodeURIComponent(q)})`,
  };
}

export async function toolGetExpenseSummary(
  tenantId: string,
  tenant: { timezone: string },
  opts?: { fromYmd?: string; toYmd?: string },
): Promise<ChatReply> {
  const now = new Date();
  const defaultTo = businessDateYmd(now, tenant.timezone);
  const defaultFrom = `${defaultTo.slice(0, 7)}-01`;
  const fromYmd = opts?.fromYmd?.trim() || defaultFrom;
  const toYmd = opts?.toYmd?.trim() || defaultTo;
  const range = zonedRangeUtc(fromYmd, toYmd, tenant.timezone);

  const docs = await prisma.document.findMany({
    where: {
      tenantId,
      deletedAt: null,
      type: "expense",
      businessDate: { gte: range.start, lte: range.end },
      amountMinor: { not: null },
    },
    select: {
      id: true,
      title: true,
      vendorName: true,
      amountMinor: true,
      businessDate: true,
    },
    orderBy: { businessDate: "desc" },
    take: 50,
  });

  if (docs.length === 0) {
    return {
      markdown: `기간 **${fromYmd}** ~ **${toYmd}**에 지출 문서가 없습니다.`,
    };
  }

  const total = docs.reduce((s, d) => s + (d.amountMinor ?? 0), 0);
  const byVendor = new Map<string, { count: number; sum: number }>();
  for (const d of docs) {
    const v = d.vendorName || "미분류";
    const cur = byVendor.get(v) ?? { count: 0, sum: 0 };
    cur.count++;
    cur.sum += d.amountMinor ?? 0;
    byVendor.set(v, cur);
  }
  const vendorLines = [...byVendor.entries()]
    .sort((a, b) => b[1].sum - a[1].sum)
    .slice(0, 10)
    .map(
      ([v, { count, sum }]) =>
        `- ${v}: ${sum.toLocaleString("ko-KR")}원 (${count}건)`,
    )
    .join("\n");

  return {
    markdown:
      `기간 **${fromYmd}** ~ **${toYmd}** 지출 합계: **${total.toLocaleString("ko-KR")}원** (${docs.length}건)\n\n` +
      `공급자별:\n${vendorLines}`,
  };
}

export async function toolGetJournalSummary(
  tenantId: string,
): Promise<ChatReply> {
  const [draftCount, postedCount, totalCount] = await Promise.all([
    prisma.journalEntry.count({ where: { tenantId, status: "draft" } }),
    prisma.journalEntry.count({ where: { tenantId, status: "posted" } }),
    prisma.journalEntry.count({ where: { tenantId } }),
  ]);

  return {
    markdown:
      `지출 내역 현황:\n\n` +
      `- 미승인: **${draftCount}**건\n` +
      `- 승인 완료: **${postedCount}**건\n` +
      `- 전체: **${totalCount}**건\n\n` +
      `[지출 내역](/journal)`,
  };
}

export async function toolGetDocumentsList(
  tenantId: string,
  tenant: { timezone: string },
  opts?: { fromYmd?: string; toYmd?: string; status?: string },
): Promise<ChatReply> {
  const now = new Date();
  const defaultTo = businessDateYmd(now, tenant.timezone);
  const fromYmd = opts?.fromYmd?.trim() || defaultTo;
  const toYmd = opts?.toYmd?.trim() || defaultTo;
  const range = zonedRangeUtc(fromYmd, toYmd, tenant.timezone);

  const where: Record<string, unknown> = {
    tenantId,
    deletedAt: null,
    createdAt: { gte: range.start, lte: range.end },
  };
  if (opts?.status) {
    where.status = opts.status;
  }

  const docs = await prisma.document.findMany({
    where,
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      amountMinor: true,
      vendorName: true,
      businessDate: true,
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  if (docs.length === 0) {
    return {
      markdown: `기간 **${fromYmd}** ~ **${toYmd}**에 등록된 문서가 없습니다.`,
    };
  }

  const list = docs
    .map((d) => {
      const amt =
        d.amountMinor != null
          ? `${d.amountMinor.toLocaleString("ko-KR")}원`
          : "";
      return `- [${d.title ?? "제목 없음"}](/inbox/${d.id}) · 「${documentTypeLabelKo(d.type as DocumentType)}」${d.vendorName ? ` · ${d.vendorName}` : ""}${amt ? ` · ${amt}` : ""} · ${documentStatusLabelKo(d.status)}`;
    })
    .join("\n");

  return {
    markdown: `기간 **${fromYmd}** ~ **${toYmd}** 문서 ${docs.length}건:\n\n${list}`,
  };
}

export async function matchChatKeywordReply(
  tenantId: string,
  message: string,
  tenant: { timezone: string },
): Promise<ChatReply | null> {
  const m = message.trim();
  if (/일일|마감|daily|오늘/i.test(m)) {
    return toolGetDailyReport(tenantId, tenant);
  }
  if (/손익|매출|비용|pnl/i.test(m)) {
    return toolGetPnl(tenantId, tenant);
  }
  return null;
}

export async function dispatchChatMessageRegex(
  tenantId: string,
  message: string,
  tenant: { timezone: string },
): Promise<ChatReply> {
  const hit = await matchChatKeywordReply(tenantId, message, tenant);
  if (hit) return hit;

  return {
    markdown:
      "**Gemini API 키가 없어** 자연어 챗이 비활성화된 상태입니다.\n\n" +
      "채팅에서는 **일일·손익**을 키워드로 바로 조회할 수 있습니다.\n\n" +
      "- **일일** 또는 **마감** — 오늘 영업일·마감·미승인 지출 건수\n" +
      "- **손익** — 이번 달 손익 요약\n\n" +
      "그 외 질문·문서 검색은 AI 조회가 켜져 있을 때 자연어로 가능합니다.",
  };
}
