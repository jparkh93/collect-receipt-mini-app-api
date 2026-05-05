import { SchemaType, type ObjectSchema, type Part } from "@google/generative-ai";
import { DocumentType } from "@prisma/client";
import { getGeminiClient, getGeminiModelId } from "./gemini";

const CATEGORY_ENUM = ["expense", "contract", "other"] as const;

const GROUPS_SCHEMA: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    groups: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          ids: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: "같은 문서(증빙)에 속한 스테이징 id 목록",
          },
          category: {
            type: SchemaType.STRING,
            format: "enum",
            enum: [...CATEGORY_ENUM],
            description:
              "묶음 전체의 문서 종류: expense=영수증·세금계산서 등 금전 지출 관련, contract=법적 계약, other=판별 어려움",
          },
        },
        required: ["ids", "category"],
      },
    },
  },
  required: ["groups"],
};

function stripJsonFence(s: string): string {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t;
}

function parseCategory(raw: unknown): DocumentType {
  if (typeof raw !== "string") return DocumentType.other;
  if ((CATEGORY_ENUM as readonly string[]).includes(raw)) {
    return raw as DocumentType;
  }
  return DocumentType.other;
}

export type StagedGroupWithCategory = {
  ids: string[];
  category: DocumentType;
};

async function classifySingleImage(
  item: { id: string; mimeType: string; base64: string },
): Promise<StagedGroupWithCategory[]> {
  const genai = getGeminiClient();
  if (!genai) {
    return [{ ids: [item.id], category: DocumentType.other }];
  }

  const model = genai.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          category: {
            type: SchemaType.STRING,
            format: "enum",
            enum: [...CATEGORY_ENUM],
          },
        },
        required: ["category"],
      },
    },
  });

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "이 이미지의 문서 종류를 분류하세요.\n- expense: 금전 지출 관련 서류 (영수증, 카드전표, 세금계산서, 거래명세서, 배송전표, 견적서 등)\n- contract: 법적 계약 문서\n- other: 위에 해당하지 않거나 확신이 낮을 때",
            },
            { inlineData: { mimeType: item.mimeType, data: item.base64 } },
          ],
        },
      ],
    });
    const text = result.response.text();
    const j = JSON.parse(stripJsonFence(text)) as { category?: unknown };
    return [{ ids: [item.id], category: parseCategory(j.category) }];
  } catch (e) {
    console.warn("[ai-group] single classify failed:", e);
    return [{ ids: [item.id], category: DocumentType.other }];
  }
}

export async function groupStagedImageIdsWithCategories(
  items: { id: string; mimeType: string; base64: string }[],
): Promise<StagedGroupWithCategory[]> {
  if (items.length === 0) return [];
  if (items.length === 1) {
    return classifySingleImage(items[0]);
  }

  const genai = getGeminiClient();
  if (!genai) {
    return items.map((i) => ({ ids: [i.id], category: DocumentType.other }));
  }

  const model = genai.getGenerativeModel({
    model: getGeminiModelId(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GROUPS_SCHEMA,
    },
  });

  const idSet = new Set(items.map((i) => i.id));
  const parts: Part[] = [
    {
      text: `다음은 매장·업체가 촬영한 서류 사진입니다. 각 장은 아래에 표시한 스테이징 id가 있습니다.

작업:
1) 시각적으로 같은 문서끼리만 한 그룹으로 묶으세요.
2) 각 그룹에 대해 category를 지정하세요.
   - expense: 금전 지출 관련 서류
   - contract: 법적 계약 문서
   - other: 위에 해당하지 않거나 확신이 낮을 때

규칙: 모든 스테이징 id를 정확히 한 번씩만 포함해야 합니다.`,
    },
  ];

  for (const it of items) {
    parts.push({ text: `[id=${it.id}]` });
    parts.push({ inlineData: { mimeType: it.mimeType, data: it.base64 } });
  }

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
    });
    const text = result.response.text();
    const j = JSON.parse(stripJsonFence(text)) as {
      groups?: { ids?: unknown; category?: unknown }[];
    };
    const raw = Array.isArray(j.groups) ? j.groups : [];

    const normalized: StagedGroupWithCategory[] = [];
    const seenIds = new Set<string>();

    for (const entry of raw) {
      if (!entry || typeof entry !== "object") {
        throw new Error("AI 묶음 결과 형식이 올바르지 않습니다.");
      }
      const idsRaw = entry.ids;
      if (!Array.isArray(idsRaw)) {
        throw new Error("AI 묶음 결과 형식이 올바르지 않습니다.");
      }
      const ids = idsRaw.filter((x): x is string => typeof x === "string");
      const category = parseCategory(entry.category);
      if (ids.length === 0) continue;
      for (const id of ids) {
        if (!idSet.has(id)) throw new Error("AI가 인식하지 못한 파일이 있습니다.");
        if (seenIds.has(id)) throw new Error("AI 묶음 결과에 중복이 있습니다.");
        seenIds.add(id);
      }
      normalized.push({ ids: [...ids], category });
    }

    if (seenIds.size !== idSet.size) {
      throw new Error("AI가 일부 파일을 누락했습니다.");
    }

    return normalized.filter((g) => g.ids.length > 0);
  } catch (e) {
    console.error("[ai-group] Gemini grouping failed:", e);
    throw e instanceof Error ? e : new Error("AI 묶음·분류에 실패했습니다.");
  }
}
