import type { DocumentType } from "@prisma/client";
import { getGeminiClient, getGeminiModelId } from "./gemini";

export function documentTypeLabelKo(t: DocumentType) {
  switch (t) {
    case "expense":
      return "지출";
    case "contract":
      return "계약";
    default:
      return "기타";
  }
}

export function generateDocumentTitle(input: {
  type: DocumentType;
  vendorName: string | null;
  amountMinor: number | null;
  createdAt: Date;
}): string {
  const amt =
    input.amountMinor != null
      ? `${input.amountMinor.toLocaleString("ko-KR")}원`
      : "금액 미상";
  const v = input.vendorName ?? "공급자 미상";
  const d = input.createdAt.toISOString().slice(0, 10);
  return `「${documentTypeLabelKo(input.type)}」 ${v} · ${amt} · ${d}`;
}

export function generateDocumentSummary(input: {
  vendorName: string | null;
  amountMinor: number | null;
  ocrRawText: string | null;
}): string {
  const parts: string[] = [];
  if (input.vendorName) parts.push(`공급자 ${input.vendorName}`);
  if (input.amountMinor != null)
    parts.push(`금액 ${input.amountMinor.toLocaleString("ko-KR")}원`);
  if (input.ocrRawText?.trim()) {
    const t = input.ocrRawText.trim().replace(/\s+/g, " ");
    parts.push(t.length > 180 ? `${t.slice(0, 180)}…` : t);
  }
  return parts.join(" · ") || "추출된 텍스트가 없습니다.";
}

export async function generateDocumentTitleSummaryAi(input: {
  type: DocumentType;
  vendorName: string | null;
  amountMinor: number | null;
  ocrRawText: string | null;
  items?: string[];
  createdAt: Date;
}): Promise<{ title: string; summary: string } | null> {
  const genai = getGeminiClient();
  if (!genai) return null;

  const model = genai.getGenerativeModel({ model: getGeminiModelId() });

  const body = [
    `문서 유형: ${documentTypeLabelKo(input.type)}`,
    input.vendorName ? `공급자: ${input.vendorName}` : null,
    input.amountMinor != null
      ? `금액: ${input.amountMinor.toLocaleString("ko-KR")}원`
      : null,
    input.items?.length ? `품목: ${input.items.join(", ")}` : null,
    input.ocrRawText?.trim()
      ? `추출 텍스트:\n${input.ocrRawText.trim().slice(0, 4000)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `당신은 한국 음식점 행정 앱의 문서 메타데이터 생성기입니다.
아래 정보를 바탕으로 **제목**과 **요약**만 한국어로 작성하세요.

규칙:
- 제목: 한 줄, 80자 이내, 공급자·금액·날짜가 있으면 넣기.
- 요약: 2~4문장, 핵심만. 세무 확정이 아닌 설명용임을 전제로 함.

반드시 아래 JSON 형식만 출력 (마크다운 금지):
{"title":"...","summary":"..."}

---
${body}`,
            },
          ],
        },
      ],
    });

    const raw = result.response.text().trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const j = JSON.parse(cleaned) as { title?: string; summary?: string };
    const title = typeof j.title === "string" ? j.title.trim() : "";
    const summary = typeof j.summary === "string" ? j.summary.trim() : "";
    if (!title || !summary) return null;
    return { title, summary };
  } catch {
    return null;
  }
}

export function generateDocumentTitleFallback(input: {
  type: DocumentType;
  vendorName: string | null;
  amountMinor: number | null;
  createdAt: Date;
}) {
  return generateDocumentTitle(input);
}

export function generateDocumentSummaryFallback(input: {
  vendorName: string | null;
  amountMinor: number | null;
  ocrRawText: string | null;
}) {
  return generateDocumentSummary(input);
}
