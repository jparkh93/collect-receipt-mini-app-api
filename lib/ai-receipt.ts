import { SchemaType, type ObjectSchema } from "@google/generative-ai";
import { getGeminiClient, getGeminiModelId } from "./gemini";

export type PaymentMethod = "cash" | "card" | "transfer";

export type ExtractedReceiptJson = {
  vendorName: string | null;
  amountMinor: number | null;
  items: string[];
  date: string | null;
  ocrRawText: string;
  paymentMethod: PaymentMethod | null;
};

const EXTRACTION_SCHEMA: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    vendorName: {
      type: SchemaType.STRING,
      nullable: true,
      description: "상호명 또는 공급자명",
    },
    amountMinor: {
      type: SchemaType.INTEGER,
      nullable: true,
      description: "총 결제금액(원 단위 정수, 부가세 포함시 합계)",
    },
    items: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "품목 요약(각 문자열 한 줄)",
    },
    date: {
      type: SchemaType.STRING,
      nullable: true,
      description: "거래일이나 발행일 YYYY-MM-DD",
    },
    ocrRawText: {
      type: SchemaType.STRING,
      description: "이미지에서 읽은 전체 텍스트(가능한 한 풀텍스트)",
    },
    paymentMethod: {
      type: SchemaType.STRING,
      nullable: true,
      description:
        "결제수단 판별: 카드전표(카드번호·승인번호 있음)='card', 현금영수증='cash', 세금계산서·거래명세서(이체 추정)='transfer', 판별불가=null",
    },
  },
  required: ["ocrRawText"],
};

function stripJsonFence(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t;
}

const VALID_PAYMENT_METHODS = new Set<PaymentMethod>(["cash", "card", "transfer"]);

function parseExtracted(raw: string): ExtractedReceiptJson | null {
  try {
    const j = JSON.parse(stripJsonFence(raw)) as ExtractedReceiptJson;
    const pm =
      typeof j.paymentMethod === "string" ? j.paymentMethod.toLowerCase() : null;
    return {
      vendorName: j.vendorName ?? null,
      amountMinor:
        typeof j.amountMinor === "number" && Number.isFinite(j.amountMinor)
          ? Math.round(j.amountMinor)
          : null,
      items: Array.isArray(j.items) ? j.items.map(String) : [],
      date: j.date ?? null,
      ocrRawText: typeof j.ocrRawText === "string" ? j.ocrRawText : "",
      paymentMethod:
        pm && VALID_PAYMENT_METHODS.has(pm as PaymentMethod)
          ? (pm as PaymentMethod)
          : null,
    };
  } catch {
    return null;
  }
}

const SINGLE_INSTRUCTION = `이 이미지는 음식점·매장에서 쓰는 영수증, 세금계산서, 배송전표, 계약서 일부 등 증빙입니다.
한국어 문맥을 고려해 금액은 '합계'·'결제금액'·'공급가액+세액' 등 실제 매입 총액(원)을 정수로 넣으세요.
품목은 짧게 요약하고, ocrRawText에는 읽을 수 있는 텍스트를 최대한 넣으세요.
결제수단(paymentMethod)은: 카드번호·승인번호가 보이면 "card", 현금영수증이면 "cash", 세금계산서·거래명세서(계좌이체 추정)이면 "transfer", 판별 불가하면 null.`;

const MULTI_INSTRUCTION = `다음은 **하나의 증빙(동일 거래)에 대한 연속 촬영** 또는 여러 장으로 된 영수증입니다.
모든 장을 합쳐 한 건의 거래로 해석하세요. 금액은 전체 합계(원) 하나만 넣고,
품목은 모든 장에서 보이는 내용을 요약하고, ocrRawText에는 각 장에서 읽은 텍스트를 순서대로 이어 붙이세요.
결제수단(paymentMethod)은: 카드번호·승인번호가 보이면 "card", 현금영수증이면 "cash", 세금계산서·거래명세서(계좌이체 추정)이면 "transfer", 판별 불가하면 null.`;

export async function extractReceiptFromImages(
  images: { mimeType: string; base64: string }[],
): Promise<ExtractedReceiptJson | null> {
  if (images.length === 0) return null;
  if (images.length === 1) {
    return extractReceiptFromImage({
      mimeType: images[0].mimeType,
      base64: images[0].base64,
    });
  }

  const genai = getGeminiClient();
  if (!genai) return null;

  const model = genai.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: EXTRACTION_SCHEMA,
    },
  });

  const parts: (
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  )[] = [{ text: MULTI_INSTRUCTION }];
  let pageNum = 1;
  for (const img of images) {
    parts.push({ text: `[페이지 ${pageNum}]` });
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    pageNum += 1;
  }

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
    });
    return parseExtracted(result.response.text());
  } catch {
    return null;
  }
}

export async function extractReceiptFromImage(args: {
  mimeType: string;
  base64: string;
}): Promise<ExtractedReceiptJson | null> {
  const genai = getGeminiClient();
  if (!genai) return null;

  const model = genai.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: EXTRACTION_SCHEMA,
    },
  });

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: SINGLE_INSTRUCTION },
            { inlineData: { mimeType: args.mimeType, data: args.base64 } },
          ],
        },
      ],
    });
    return parseExtracted(result.response.text());
  } catch {
    return null;
  }
}
